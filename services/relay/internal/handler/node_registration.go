package handler

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// nodeRegistrationOutcome classifies the result of a Storage Node registration
// attempt. Both /pairing/codes/redeem and /nodes/register share this so the two
// paths cannot diverge on node-identity semantics (Phase 7b).
type nodeRegistrationOutcome int

const (
	// nodeRegistrationOK: the node was inserted, or an existing node with the
	// same account + same public key was found (idempotent no-op).
	nodeRegistrationOK nodeRegistrationOutcome = iota
	// nodeRegistrationKeyMismatch: the node_id already exists under this
	// account with a *different* Ed25519 key. Key rotation/re-pairing is a v1
	// non-goal, so this is rejected rather than silently replacing the key.
	nodeRegistrationKeyMismatch
	// nodeRegistrationOwnedElsewhere: the node_id belongs to another account.
	// Accounts are immutable; ownership never moves.
	nodeRegistrationOwnedElsewhere
)

// errorReason is the machine-readable code reported to callers that speak the
// pairing-code failure taxonomy (see docs/security/bootstrap-pairing.md).
func (o nodeRegistrationOutcome) errorReason() string {
	switch o {
	case nodeRegistrationKeyMismatch:
		return "node_key_mismatch"
	case nodeRegistrationOwnedElsewhere:
		return "node_owned_elsewhere"
	default:
		return ""
	}
}

// storageNodeSelectByID is shared by both the classification read and the
// post-conflict re-read; the column order matches scanStorageNode.
const storageNodeSelectByID = `
	SELECT node_id, account_id, public_key, capabilities, status, is_primary, last_seen_at, created_at
	FROM storage_nodes
	WHERE node_id = $1
`

// registerStorageNode enforces the Storage Node identity invariant inside an
// existing transaction:
//
//   - existing node_id, another account      -> nodeRegistrationOwnedElsewhere
//   - existing node_id, same account, new key -> nodeRegistrationKeyMismatch
//   - existing node_id, same account, same key -> nodeRegistrationOK, no mutation
//     (key, status, capabilities and is_primary are all preserved; a REVOKED or
//     otherwise non-ACTIVE node is never silently reactivated)
//   - new node_id                              -> inserted ACTIVE; is_primary is
//     assigned to the account's first node, protected by idx_storage_nodes_one_primary
//
// The savepoint makes the insert safe against the partial unique index: a
// concurrent first-node insert loses the unique race, the savepoint is rolled
// back (so the enclosing transaction is not aborted), and the loser is retried
// as a non-primary node.
func registerStorageNode(
	ctx context.Context,
	tx pgx.Tx,
	accountID, nodeID, publicKey, capabilities string,
) (NodeResponse, nodeRegistrationOutcome, error) {
	existing, found, err := lookupStorageNode(ctx, tx, nodeID)
	if err != nil {
		return NodeResponse{}, nodeRegistrationOK, err
	}
	if found {
		return classifyExistingNode(existing, accountID, publicKey)
	}

	if _, err := tx.Exec(ctx, "SAVEPOINT register_storage_node"); err != nil {
		return NodeResponse{}, nodeRegistrationOK, err
	}

	inserted, err := insertStorageNode(ctx, tx, accountID, nodeID, publicKey, capabilities, true)
	if err == nil {
		if _, rErr := tx.Exec(ctx, "RELEASE SAVEPOINT register_storage_node"); rErr != nil {
			return NodeResponse{}, nodeRegistrationOK, rErr
		}
		return inserted, nodeRegistrationOK, nil
	}

	// The insert failed. Undo only the savepoint, then work out whether a
	// concurrent transaction created the row (node_id conflict) or whether the
	// one-primary invariant rejected it.
	if _, rbErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT register_storage_node"); rbErr != nil {
		return NodeResponse{}, nodeRegistrationOK, rbErr
	}

	again, found, err := lookupStorageNode(ctx, tx, nodeID)
	if err != nil {
		return NodeResponse{}, nodeRegistrationOK, err
	}
	if found {
		if _, rErr := tx.Exec(ctx, "RELEASE SAVEPOINT register_storage_node"); rErr != nil {
			return NodeResponse{}, nodeRegistrationOK, rErr
		}
		return classifyExistingNode(again, accountID, publicKey)
	}

	// No node_id row exists, so the conflict was idx_storage_nodes_one_primary:
	// another node already holds is_primary for this account. Retry as a
	// secondary node.
	retried, err := insertStorageNode(ctx, tx, accountID, nodeID, publicKey, capabilities, false)
	if err != nil {
		return NodeResponse{}, nodeRegistrationOK, err
	}
	if _, rErr := tx.Exec(ctx, "RELEASE SAVEPOINT register_storage_node"); rErr != nil {
		return NodeResponse{}, nodeRegistrationOK, rErr
	}
	return retried, nodeRegistrationOK, nil
}

// classifyExistingNode applies the identity invariant to an already-present row.
func classifyExistingNode(existing NodeResponse, accountID, publicKey string) (NodeResponse, nodeRegistrationOutcome, error) {
	if existing.AccountID != accountID {
		return NodeResponse{}, nodeRegistrationOwnedElsewhere, nil
	}
	if existing.PublicKey != publicKey {
		return NodeResponse{}, nodeRegistrationKeyMismatch, nil
	}
	// Same account, same key: idempotent success. Deliberately no mutation so
	// the node's status/is_primary and registered key are preserved.
	return existing, nodeRegistrationOK, nil
}

// lookupStorageNode returns the stored node and whether it exists.
func lookupStorageNode(ctx context.Context, tx pgx.Tx, nodeID string) (NodeResponse, bool, error) {
	node, err := scanStorageNode(tx.QueryRow(ctx, storageNodeSelectByID, nodeID))
	if errors.Is(err, pgx.ErrNoRows) {
		return NodeResponse{}, false, nil
	}
	if err != nil {
		return NodeResponse{}, false, err
	}
	return node, true, nil
}

// insertStorageNode inserts a brand-new node row. When allowPrimary is true the
// node becomes primary only if the account has no nodes yet; the CASE is still
// subject to the partial unique index, which is the authoritative guard.
func insertStorageNode(
	ctx context.Context,
	tx pgx.Tx,
	accountID, nodeID, publicKey, capabilities string,
	allowPrimary bool,
) (NodeResponse, error) {
	const query = `
		INSERT INTO storage_nodes (node_id, account_id, public_key, capabilities, status, is_primary)
		VALUES ($1, $2, $3, $4::jsonb, 'ACTIVE',
		        CASE WHEN $5 THEN NOT EXISTS (SELECT 1 FROM storage_nodes WHERE account_id = $2)
		             ELSE false END)
		RETURNING node_id, account_id, public_key, capabilities, status, is_primary, last_seen_at, created_at
	`
	return scanStorageNode(tx.QueryRow(ctx, query, nodeID, accountID, publicKey, capabilities, allowPrimary))
}

// scanStorageNode reads the canonical storage_nodes projection into a
// NodeResponse. Kept in one place so the SELECT and RETURNING column orders
// cannot drift apart.
func scanStorageNode(row pgx.Row) (NodeResponse, error) {
	var (
		node    NodeResponse
		capsRaw []byte
	)
	if err := row.Scan(
		&node.NodeID,
		&node.AccountID,
		&node.PublicKey,
		&capsRaw,
		&node.Status,
		&node.IsPrimary,
		&node.LastSeenAt,
		&node.CreatedAt,
	); err != nil {
		return NodeResponse{}, err
	}
	_ = json.Unmarshal(capsRaw, &node.Capabilities)
	return node, nil
}
