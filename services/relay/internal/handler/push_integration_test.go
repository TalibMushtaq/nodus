package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/push"
	"github.com/stretchr/testify/require"
)

// recordingSender captures the messages a push Service would deliver.
type recordingSender struct{ messages []push.Message }

func (r *recordingSender) Send(_ context.Context, messages []push.Message) error {
	r.messages = append(r.messages, messages...)
	return nil
}

func authContext(account, device string) context.Context {
	ctx := context.WithValue(context.Background(), auth.AccountIDKey, account)
	return context.WithValue(ctx, auth.DeviceIDKey, device)
}

func TestRegisterPushTokenAndAlertConflictsOnce(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account, device, file := "acct-push-"+suffix, "dev-push-"+suffix, "file-push-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, 'pk')`, device, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh', 1)
	`, file)
	require.NoError(t, err)

	// Register a token through the handler.
	body := strings.NewReader(`{"token":"ExponentPushToken[x]","platform":"ios","prefs":{"conflicts":true}}`)
	req := httptest.NewRequest(http.MethodPost, "/devices/push-token", body)
	req = req.WithContext(authContext(account, device))
	rr := httptest.NewRecorder()
	RegisterPushToken(pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var token string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT token FROM push_tokens WHERE device_id = $1`, device).Scan(&token))
	require.Equal(t, "ExponentPushToken[x]", token)

	// The conflict is announced exactly once; a repeat apply does not re-send.
	sender := &recordingSender{}
	svc := push.NewService(pool, sender, nil)
	svc.AlertConflicts(ctx, account)
	require.Len(t, sender.messages, 1)
	require.Equal(t, "ExponentPushToken[x]", sender.messages[0].To)

	svc.AlertConflicts(ctx, account)
	require.Len(t, sender.messages, 1)

	// Deleting the token unregisters the device.
	delReq := httptest.NewRequest(http.MethodDelete, "/devices/push-token", nil)
	delReq = delReq.WithContext(authContext(account, device))
	delRes := httptest.NewRecorder()
	DeletePushToken(pool)(delRes, delReq)
	require.Equal(t, http.StatusOK, delRes.Code)

	var count int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM push_tokens WHERE device_id = $1`, device).Scan(&count))
	require.Equal(t, 0, count)
}

func TestConflictAlertHonoursOptOut(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account, device, file := "acct-pushoff-"+suffix, "dev-pushoff-"+suffix, "file-pushoff-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, 'pk')`, device, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh', 1)
	`, file)
	require.NoError(t, err)
	// The device has a token but opted out of conflict alerts.
	_, err = pool.Exec(ctx, `
		INSERT INTO push_tokens (device_id, account_id, token, platform, notify_conflicts)
		VALUES ($1, $2, 'ExponentPushToken[off]', 'android', FALSE)
	`, device, account)
	require.NoError(t, err)

	sender := &recordingSender{}
	push.NewService(pool, sender, nil).AlertConflicts(ctx, account)
	require.Empty(t, sender.messages)
}

// recordingWebSender captures browser push deliveries.
type recordingWebSender struct {
	subs  []push.WebSubscription
	title string
}

func (r *recordingWebSender) SendWeb(
	_ context.Context,
	subs []push.WebSubscription,
	title, _ string,
	_ map[string]string,
) error {
	r.subs = append(r.subs, subs...)
	r.title = title
	return nil
}

func TestConflictAlertAlsoReachesWebSubscriptions(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account, file := "acct-webpush-"+suffix, "file-webpush-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh', 1)
	`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO web_push_subscriptions (endpoint, account_id, p256dh, auth)
		VALUES ('https://push.example/abc', $1, 'p256', 'auth')
	`, account)
	require.NoError(t, err)

	sender := &recordingSender{}
	web := &recordingWebSender{}
	push.NewService(pool, sender, web).AlertConflicts(ctx, account)

	require.Len(t, web.subs, 1)
	require.Equal(t, "https://push.example/abc", web.subs[0].Endpoint)
	require.Equal(t, "New file conflict", web.title)
}

func TestSyncCompleteAlertFiresOnceWhenAllShardsStored(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account := "acct-sync-" + suffix
	device := "dev-sync-" + suffix
	node := "node-sync-" + suffix
	file := "file-sync-" + suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO devices (device_id, account_id, public_key) VALUES ($1, $2, 'pk')`, device, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'pk')`, node, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, version_hash, shard_count)
		VALUES ($1, 1, 'vh', 2)
	`, file)
	require.NoError(t, err)
	// One shard is still in transit, so the version is not fully backed up yet.
	_, err = pool.Exec(ctx, `
		INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status)
		VALUES ($1, 1, 0, $2, 'NODE_STORED'), ($1, 1, 1, $2, 'NODE_RECEIVING')
	`, file, node)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO push_tokens (device_id, account_id, token, platform)
		VALUES ($1, $2, 'ExponentPushToken[sync]', 'ios')
	`, device, account)
	require.NoError(t, err)

	sender := &recordingSender{}
	svc := push.NewService(pool, sender, nil)

	// Incomplete: no notification.
	svc.AlertSyncComplete(ctx, account, file, 1)
	require.Empty(t, sender.messages)

	// The last shard lands: notify exactly once.
	_, err = pool.Exec(ctx, `
		UPDATE file_locations SET status = 'NODE_STORED'
		WHERE file_id = $1 AND version_number = 1 AND shard_index = 1
	`, file)
	require.NoError(t, err)
	svc.AlertSyncComplete(ctx, account, file, 1)
	require.Len(t, sender.messages, 1)
	require.Equal(t, "ExponentPushToken[sync]", sender.messages[0].To)

	// Repeat acks do not re-notify.
	svc.AlertSyncComplete(ctx, account, file, 1)
	require.Len(t, sender.messages, 1)
}
