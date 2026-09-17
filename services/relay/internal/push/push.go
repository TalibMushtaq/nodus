// Package push delivers account notifications through Expo's push service.
//
// The Relay owns recipient resolution (which devices opted into which
// category) and fan-out; the transport is behind a small Sender interface so it
// can be faked in tests. Payload copy is deliberately generic: file names are
// encrypted (ADR-0001), so a notification must never carry a decrypted name.
package push

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// Category is a notification class the client can opt out of individually.
type Category string

const (
	CategoryConflicts     Category = "conflicts"
	CategoryDeviceOffline Category = "device_offline"
	CategorySyncComplete  Category = "sync_complete"
)

// categoryColumn maps a category to the push_tokens opt-in column. Fixed
// values only — never interpolate caller input into SQL.
var categoryColumn = map[Category]string{
	CategoryConflicts:     "notify_conflicts",
	CategoryDeviceOffline: "notify_device_offline",
	CategorySyncComplete:  "notify_sync_complete",
}

// Message is one push notification.
type Message struct {
	To    string
	Title string
	Body  string
	Data  map[string]string
}

// Sender dispatches messages. Implementations should batch internally.
type Sender interface {
	Send(ctx context.Context, messages []Message) error
}

// Service resolves recipients and dispatches through the configured senders.
// Either sender may be nil (e.g. no VAPID keys configured); the service then
// simply skips that channel.
type Service struct {
	pool      *db.Pool
	sender    Sender
	webSender WebSender
}

func NewService(pool *db.Pool, sender Sender, webSender WebSender) *Service {
	return &Service{pool: pool, sender: sender, webSender: webSender}
}

// defaultService is the process-wide instance wired in main and used by the
// event-apply path, which has no direct handle on the service.
var defaultService *Service

func SetDefault(s *Service) { defaultService = s }

func Default() *Service { return defaultService }

// NotifyAccount sends a message to every device/browser of the account that has
// registered a delivery target and has not opted out of the category.
// Best-effort: errors are logged.
func (s *Service) NotifyAccount(
	ctx context.Context,
	accountID string,
	category Category,
	title, body string,
	data map[string]string,
) {
	if s == nil || s.pool == nil || accountID == "" {
		return
	}
	column, ok := categoryColumn[category]
	if !ok {
		log.Printf("[push] unknown category %q", category)
		return
	}

	// Expo push tokens (mobile).
	messages := make([]Message, 0)
	if s.sender != nil {
		rows, err := s.pool.Query(ctx,
			fmt.Sprintf(`SELECT token FROM push_tokens WHERE account_id = $1 AND %s`, column),
			accountID)
		if err != nil {
			log.Printf("[push] query tokens: %v", err)
		} else {
			for rows.Next() {
				var token string
				if rows.Scan(&token) == nil && token != "" {
					messages = append(messages, Message{To: token, Title: title, Body: body, Data: data})
				}
			}
			rows.Close()
		}
	}

	// Browser push subscriptions (web).
	webSubs := make([]WebSubscription, 0)
	if s.webSender != nil {
		rows, err := s.pool.Query(ctx,
			fmt.Sprintf(`SELECT endpoint, p256dh, auth FROM web_push_subscriptions WHERE account_id = $1 AND %s`, column),
			accountID)
		if err != nil {
			log.Printf("[push] query web subscriptions: %v", err)
		} else {
			for rows.Next() {
				var sub WebSubscription
				if rows.Scan(&sub.Endpoint, &sub.P256dh, &sub.Auth) == nil && sub.Endpoint != "" {
					webSubs = append(webSubs, sub)
				}
			}
			rows.Close()
		}
	}

	if len(messages) == 0 && len(webSubs) == 0 {
		return
	}

	sendCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if len(messages) > 0 {
		if err := s.sender.Send(sendCtx, messages); err != nil {
			log.Printf("[push] send %s: %v", category, err)
		}
	}
	if len(webSubs) > 0 {
		if err := s.webSender.SendWeb(sendCtx, webSubs, title, body, data); err != nil {
			log.Printf("[push] web send %s: %v", category, err)
		}
	}
}

// AlertConflicts announces files that have a flagged (conflicted) version and
// have not been announced yet. The claim is a single INSERT ... ON CONFLICT DO
// NOTHING ... RETURNING, so concurrent applies cannot double-notify.
func (s *Service) AlertConflicts(ctx context.Context, accountID string) {
	if s == nil || s.pool == nil || (s.sender == nil && s.webSender == nil) || accountID == "" {
		return
	}

	rows, err := s.pool.Query(ctx, `
		INSERT INTO conflict_notices (account_id, file_id)
		SELECT f.account_id, fv.file_id
		FROM file_versions fv
		JOIN files f ON f.file_id = fv.file_id
		WHERE f.account_id = $1 AND fv.conflict_status = 'flagged'
		ON CONFLICT (account_id, file_id) DO NOTHING
		RETURNING file_id
	`, accountID)
	if err != nil {
		log.Printf("[push] claim conflicts: %v", err)
		return
	}
	newConflicts := 0
	for rows.Next() {
		var fileID string
		if rows.Scan(&fileID) == nil {
			newConflicts++
		}
	}
	rows.Close()
	if newConflicts == 0 {
		return
	}

	s.NotifyAccount(
		ctx,
		accountID,
		CategoryConflicts,
		"New file conflict",
		"A file has a conflicting copy that needs review.",
		map[string]string{"type": string(CategoryConflicts)},
	)
}

// AlertSyncComplete notifies the account once when every shard of a file
// version has been committed to a storage node. The `sync_notices` claim makes
// this idempotent across the many shard acks that make up one version.
func (s *Service) AlertSyncComplete(ctx context.Context, accountID, fileID string, versionNumber int) {
	if s == nil || s.pool == nil || (s.sender == nil && s.webSender == nil) || accountID == "" || fileID == "" {
		return
	}

	var total, stored int
	err := s.pool.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT shard_count FROM file_versions WHERE file_id = $1 AND version_number = $2), 0),
			(SELECT COUNT(*) FROM file_locations
			 WHERE file_id = $1 AND version_number = $2 AND status = 'NODE_STORED')
	`, fileID, versionNumber).Scan(&total, &stored)
	if err != nil || total == 0 || stored < total {
		return
	}

	tag, err := s.pool.Exec(ctx, `
		INSERT INTO sync_notices (account_id, file_id, version_number)
		VALUES ($1, $2, $3)
		ON CONFLICT (account_id, file_id, version_number) DO NOTHING
	`, accountID, fileID, versionNumber)
	if err != nil || tag.RowsAffected() == 0 {
		// Already announced for this version, or the claim failed.
		return
	}

	s.NotifyAccount(
		ctx,
		accountID,
		CategorySyncComplete,
		"Backup complete",
		"A file finished syncing to your storage node.",
		map[string]string{"type": string(CategorySyncComplete)},
	)
}
