use sqlx::{Connection, SqliteConnection, SqlitePool};

use super::conflict::{
    detect_branch_conflict_conn, existing_slot_conn, generate_conflicted_filename,
    is_fork_occupant, mark_branch_flagged_conn, next_free_version_number_conn,
};
use super::types::{BatchAckPayload, EventBatchPayload, FileVersionPayload, SyncEvent};

#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied,
    AlreadyApplied,
    Conflicted {
        conflicted_filename: String,
        sibling_version: i64,
    },
}

/// A known event whose payload is deterministically malformed, so retrying can
/// never succeed. `apply_incoming_batch` acks (skips) these instead of leaving
/// them to block the origin's stream forever; transient errors are retried.
#[derive(Debug)]
pub struct MalformedEvent(pub String);

impl std::fmt::Display for MalformedEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for MalformedEvent {}

/// Apply a single remote sync event idempotently to SQLite database.
pub async fn apply_remote_event(
    db: &SqlitePool,
    event: &SyncEvent,
    local_node_id: &str,
) -> anyhow::Result<ApplyOutcome> {
    let mut conn = db.acquire().await?;
    apply_remote_event_conn(&mut conn, event, local_node_id).await
}

/// True when a tombstone exists for `entity_type`/`entity_id`. Create/version
/// projections consult this to avoid resurrecting a deleted entity (parity with
/// the Relay, which filters these in `sync.go`). The event is still acknowledged
/// and the cursor advances; only the projection is skipped.
async fn has_tombstone_conn(
    conn: &mut SqliteConnection,
    entity_type: &str,
    entity_id: &str,
) -> anyhow::Result<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tombstones WHERE entity_type = ? AND entity_id = ?",
    )
    .bind(entity_type)
    .bind(entity_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count > 0)
}

/// Apply a `FILE_SHARD_MANIFEST`: verify the origin device's signature over the
/// declared per-shard hashes, store them, and re-check any shard already
/// recorded for that version. Runs on the caller's transaction.
///
/// The manifest is the only authoritative per-shard hash the node ever gets
/// (the version event carries only the whole-version hash), so an unsigned or
/// wrong-device manifest is ignored rather than trusted.
async fn apply_shard_manifest_conn(
    conn: &mut SqliteConnection,
    event: &SyncEvent,
) -> anyhow::Result<()> {
    let malformed = |detail: String| anyhow::Error::new(MalformedEvent(detail));

    let file_id = event
        .payload
        .get("file_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version_number = event
        .payload
        .get("version_number")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let signature = event
        .payload
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let hashes: Vec<String> = event
        .payload
        .get("shard_hashes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if file_id.is_empty()
        || version_number < 1
        || signature.is_empty()
        || hashes.is_empty()
        || hashes
            .iter()
            .any(|h| !crate::store::layout::is_valid_object_id(h))
    {
        return Err(malformed(format!(
            "invalid FILE_SHARD_MANIFEST for {file_id}:{version_number}"
        )));
    }

    // The manifest must come from a paired, active device; the Relay cannot
    // forge a device signature.
    let pubkey: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT public_key_bytes FROM devices WHERE device_id = ? AND status = 'ACTIVE'",
    )
    .bind(&event.origin_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(pubkey) = pubkey else {
        eprintln!(
            "[sync] ignoring FILE_SHARD_MANIFEST from unverified origin {}",
            event.origin_id
        );
        return Ok(());
    };

    let manifest_hash = blake3::hash(hashes.join(",").as_bytes())
        .to_hex()
        .to_string();
    let message = format!("nodus-shard-manifest:v1:{file_id}:{version_number}:{manifest_hash}");
    if crate::local::auth::verify_signature(&pubkey, message.as_bytes(), &signature).is_err() {
        eprintln!(
            "[sync] rejecting FILE_SHARD_MANIFEST for {file_id}:{version_number}: \
             signature does not verify"
        );
        return Ok(());
    }

    // If the version row exists, its declared shard count must agree.
    let expected_count: Option<i64> = sqlx::query_scalar(
        "SELECT shard_count FROM file_versions WHERE file_id = ? AND version_number = ?",
    )
    .bind(&file_id)
    .bind(version_number)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(count) = expected_count
        && count != hashes.len() as i64
    {
        eprintln!(
            "[sync] rejecting FILE_SHARD_MANIFEST for {file_id}:{version_number}: \
             {} hashes but shard_count is {count}",
            hashes.len()
        );
        return Ok(());
    }

    sqlx::query("DELETE FROM file_version_shard_hashes WHERE file_id = ? AND version_number = ?")
        .bind(&file_id)
        .bind(version_number)
        .execute(&mut *conn)
        .await?;
    for (index, hash) in hashes.iter().enumerate() {
        sqlx::query(
            "INSERT INTO file_version_shard_hashes (file_id, version_number, shard_index, shard_hash) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(&file_id)
        .bind(version_number)
        .bind(index as i64)
        .bind(hash)
        .execute(&mut *conn)
        .await?;
    }

    // Re-check shards already stored for this version (they may have arrived
    // before the manifest). A mismatch means a relay/peer delivered wrong bytes;
    // mark the object DEGRADED so it is not silently trusted.
    let recorded: Vec<(i64, String)> = sqlx::query_as(
        "SELECT shard_index, object_id FROM shards WHERE file_id = ? AND version_number = ?",
    )
    .bind(&file_id)
    .bind(version_number)
    .fetch_all(&mut *conn)
    .await?;
    for (index, object_id) in recorded {
        if let Some(expected) = hashes.get(index as usize)
            && expected != &object_id
        {
            eprintln!(
                "[sync] shard {file_id}:{version_number}:{index} stored object {object_id} \
                 does not match the signed manifest ({expected}); marking DEGRADED"
            );
            sqlx::query("UPDATE storage_objects SET status = 'DEGRADED' WHERE object_id = ?")
                .bind(&object_id)
                .execute(&mut *conn)
                .await?;
        }
    }

    Ok(())
}

/// Connection variant of [`apply_remote_event`]: the idempotency check, the
/// `sync_events` insert, every domain projection and the cursor update all run
/// inside ONE transaction, so a mid-projection failure (e.g. an unfulfillable
/// shard FK) rolls the whole event back instead of leaving partial rows that a
/// later retry would skip as AlreadyApplied (#6).
pub(crate) async fn apply_remote_event_conn(
    conn: &mut SqliteConnection,
    event: &SyncEvent,
    local_node_id: &str,
) -> anyhow::Result<ApplyOutcome> {
    let mut tx = conn.begin().await?;

    // 1. Idempotency check: see if (origin_id, origin_sequence) or event_id is already in sync_events
    let existing = sqlx::query(
        r#"
        SELECT 1 AS dummy
        FROM sync_events
        WHERE (origin_id = ? AND origin_sequence = ?) OR event_id = ?
        LIMIT 1
        "#,
    )
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.event_id)
    .fetch_optional(&mut *tx)
    .await?;

    if existing.is_some() {
        return Ok(ApplyOutcome::AlreadyApplied);
    }

    let payload_str = serde_json::to_string(&event.payload)?;

    // 2. Insert into sync_events log
    let inserted = sqlx::query(
        r#"
        INSERT INTO sync_events (event_id, origin_id, origin_sequence, event_type, payload, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_id, origin_sequence) DO NOTHING
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.event_type)
    .bind(&payload_str)
    .bind(&event.timestamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // Two connections can both pass the deferred SELECT above and race here;
    // the loser's insert is a no-op. It must not then re-run the projections
    // (which could renumber a fork sibling or otherwise double-apply), so treat
    // a no-op insert as already applied.
    if inserted == 0 {
        return Ok(ApplyOutcome::AlreadyApplied);
    }

    let mut outcome = ApplyOutcome::Applied;

    // 3. Domain projections
    match event.event_type.as_str() {
        "FILE_CREATED" => {
            let file_id = event
                .payload
                .get("file_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let parent_folder_id = event
                .payload
                .get("parent_folder_id")
                .and_then(|v| v.as_str());
            let encrypted_name = event.payload.get("encrypted_name").and_then(|v| v.as_str());

            // Anti-resurrection (matches the Relay): a create for a tombstoned
            // file is acknowledged but not projected, so a long-offline device
            // cannot revive a deleted file.
            if !file_id.is_empty() && !has_tombstone_conn(&mut tx, "file", file_id).await? {
                sqlx::query(
                    r#"
                    INSERT INTO files (file_id, parent_folder_id, encrypted_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(file_id) DO UPDATE SET
                        parent_folder_id = excluded.parent_folder_id,
                        encrypted_name = excluded.encrypted_name,
                        updated_at = excluded.updated_at
                    "#,
                )
                .bind(file_id)
                .bind(parent_folder_id)
                .bind(encrypted_name)
                .bind(&event.timestamp)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        "FILE_VERSION_ADDED" | "FILE_MODIFIED" => {
            'project_version: {
                // A payload that cannot be parsed is deterministically bad: surface
                // it as a malformed event so the batch acks/skips it rather than
                // silently dropping it (the old `if let Ok` swallow) or retrying
                // forever.
                let ver = serde_json::from_value::<FileVersionPayload>(event.payload.clone())
                    .map_err(|e| {
                        anyhow::Error::new(MalformedEvent(format!(
                            "invalid {} payload: {e}",
                            event.event_type
                        )))
                    })?;
                // The protocol requires version_number >= 1; a non-positive
                // value is malformed input, not a valid version to project.
                if ver.version_number < 1 {
                    return Err(anyhow::Error::new(MalformedEvent(format!(
                        "{} has non-positive version_number {}",
                        event.event_type, ver.version_number
                    ))));
                }
                // Anti-resurrection (matches the Relay): a version for a
                // tombstoned file is acknowledged but not projected, so a
                // long-offline device cannot revive a deleted file. The cursor
                // still advances below; the event is deliberately dropped.
                if has_tombstone_conn(&mut tx, "file", &ver.file_id).await? {
                    break 'project_version;
                }
                // Ensure parent file row exists
                sqlx::query(
                    r#"
                    INSERT INTO files (file_id, created_at, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(file_id) DO NOTHING
                    "#,
                )
                .bind(&ver.file_id)
                .bind(&event.timestamp)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;

                // ── Preserve-both conflict handling (#10) ─────────────────
                // The claimed (file_id, version_number) slot may already be
                // occupied by a genuinely different version: two branches both
                // picked the same number offline, either from different parents
                // or by both editing the same parent into the same number. A
                // naive upsert would overwrite (lose) the earlier sibling. Keep
                // both: give the incoming version a fresh MAX+1 slot and mark
                // both versions flagged, mirroring the Relay's symmetric
                // flagging so the conflicted state survives on the node.
                let occupant =
                    existing_slot_conn(&mut tx, &ver.file_id, ver.version_number).await?;

                let fork_collision = occupant.as_ref().is_some_and(|o| is_fork_occupant(o, &ver));

                let sibling_conflict = detect_branch_conflict_conn(
                    &mut tx,
                    &ver.file_id,
                    ver.parent_version_id,
                    ver.version_number,
                )
                .await?;

                let is_flagged = ver.conflict_status.as_deref() == Some("flagged")
                    || sibling_conflict.is_some()
                    || fork_collision;

                // Symmetric flagging: the whole branch set gets flagged, and a
                // fork-collided occupant (living on a different parent) is
                // flagged individually.
                if is_flagged {
                    mark_branch_flagged_conn(&mut tx, &ver.file_id, ver.parent_version_id).await?;
                    if fork_collision {
                        sqlx::query(
                            "UPDATE file_versions SET conflict_status = 'flagged' WHERE file_id = ? AND version_number = ?",
                        )
                        .bind(&ver.file_id)
                        .bind(ver.version_number)
                        .execute(&mut *tx)
                        .await?;
                    }
                }

                let effective_number = if fork_collision {
                    next_free_version_number_conn(&mut tx, &ver.file_id).await?
                } else {
                    ver.version_number
                };

                let stored_status = if is_flagged {
                    "flagged"
                } else {
                    ver.conflict_status.as_deref().unwrap_or("none")
                };

                sqlx::query(
                    r#"
                    INSERT INTO file_versions (file_id, version_number, parent_version_id, conflict_status, version_hash, shard_count, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(file_id, version_number) DO UPDATE SET
                        parent_version_id = excluded.parent_version_id,
                        conflict_status = excluded.conflict_status,
                        version_hash = excluded.version_hash,
                        shard_count = excluded.shard_count
                    "#,
                )
                .bind(&ver.file_id)
                .bind(effective_number)
                .bind(ver.parent_version_id)
                .bind(stored_status)
                .bind(&ver.version_hash)
                .bind(ver.shard_count)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;

                // Phase 10: shards fetched from the Relay buffer can arrive
                // before this version event. Now that the FK target exists,
                // drain matching pending rows into shards. A fork-colliding
                // version was renumbered, so its pending shards (keyed on the
                // claimed number) follow it to the new slot first.
                if fork_collision && effective_number != ver.version_number {
                    sqlx::query(
                        "UPDATE pending_shard_fetches SET version_number = ? WHERE file_id = ? AND version_number = ?",
                    )
                    .bind(effective_number)
                    .bind(&ver.file_id)
                    .bind(ver.version_number)
                    .execute(&mut *tx)
                    .await?;
                }
                drain_pending_fetches_conn(&mut tx, &ver.file_id, effective_number).await?;

                if is_flagged {
                    let base_name = ver
                        .encrypted_name
                        .clone()
                        .unwrap_or_else(|| format!("{}.nodus", ver.file_id));
                    let conflicted_name = generate_conflicted_filename(
                        &base_name,
                        &event.origin_id,
                        &event.timestamp,
                    );

                    // Persist the ADR-0003 sibling name instead of discarding it:
                    // local status can surface the conflict, and a snapshot
                    // carries it to a rebuilt Relay.
                    sqlx::query(
                        "UPDATE file_versions SET conflicted_name = ? \
                         WHERE file_id = ? AND version_number = ?",
                    )
                    .bind(&conflicted_name)
                    .bind(&ver.file_id)
                    .bind(effective_number)
                    .execute(&mut *tx)
                    .await?;

                    outcome = ApplyOutcome::Conflicted {
                        conflicted_filename: conflicted_name,
                        sibling_version: if fork_collision {
                            // The sibling we preserved it next to is the
                            // forkl-collided version that already held the slot.
                            ver.version_number
                        } else {
                            sibling_conflict.unwrap_or(0)
                        },
                    };
                }
            }
        }

        // Folder projection (Phase 14 F1). Mirrors the FILE_* handling: a
        // create upserts the folder, a delete writes a tombstone. The tombstone
        // is what stops a long-offline device from resurrecting the folder.
        "FOLDER_CREATED" => {
            let folder_id = event
                .payload
                .get("folder_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let parent_folder_id = event
                .payload
                .get("parent_folder_id")
                .and_then(|v| v.as_str());
            let encrypted_name = event.payload.get("encrypted_name").and_then(|v| v.as_str());

            // Anti-resurrection: a create for a tombstoned folder is acked but
            // not projected (docs `event-types.md`: offline devices must not
            // resurrect deleted folders).
            if !folder_id.is_empty() && !has_tombstone_conn(&mut tx, "folder", folder_id).await? {
                sqlx::query(
                    r#"
                    INSERT INTO folders (folder_id, parent_folder_id, encrypted_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(folder_id) DO UPDATE SET
                        parent_folder_id = excluded.parent_folder_id,
                        encrypted_name = excluded.encrypted_name,
                        updated_at = excluded.updated_at
                    "#,
                )
                .bind(folder_id)
                .bind(parent_folder_id)
                .bind(encrypted_name)
                .bind(&event.timestamp)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        "FOLDER_DELETED" => {
            let folder_id = event
                .payload
                .get("folder_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !folder_id.is_empty() {
                sqlx::query(
                    r#"
                    INSERT INTO tombstones (entity_type, entity_id, deleted_at)
                    VALUES ('folder', ?, ?)
                    ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
                    "#,
                )
                .bind(folder_id)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        // Key envelopes are stored opaquely for snapshot rebuilds; the node
        // cannot decrypt them. Upsert mirrors the Relay (a re-seal overwrites).
        "KEY_ENVELOPE_ADDED" => {
            let file_id = event
                .payload
                .get("file_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let recipient_id = event
                .payload
                .get("recipient_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let recipient_kind = event
                .payload
                .get("recipient_kind")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let encrypted_key = event
                .payload
                .get("encrypted_key")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !file_id.is_empty()
                && !recipient_id.is_empty()
                && !encrypted_key.is_empty()
                && (recipient_kind == "device" || recipient_kind == "node" || recipient_kind == "recovery")
            {
                sqlx::query(
                    r#"
                    INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(file_id, recipient_id) DO UPDATE SET
                        recipient_kind = excluded.recipient_kind,
                        encrypted_key = excluded.encrypted_key
                    "#,
                )
                .bind(file_id)
                .bind(recipient_id)
                .bind(recipient_kind)
                .bind(encrypted_key)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        // Folder key envelopes: opaque, keyed by folder_id. Stored for snapshot
        // rebuilds only; the node cannot decrypt the folder name.
        "FOLDER_KEY_ENVELOPE_ADDED" => {
            let folder_id = event
                .payload
                .get("folder_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let recipient_id = event
                .payload
                .get("recipient_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let recipient_kind = event
                .payload
                .get("recipient_kind")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let encrypted_key = event
                .payload
                .get("encrypted_key")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !folder_id.is_empty()
                && !recipient_id.is_empty()
                && !encrypted_key.is_empty()
                && (recipient_kind == "device" || recipient_kind == "node" || recipient_kind == "recovery")
            {
                sqlx::query(
                    r#"
                    INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(folder_id, recipient_id) DO UPDATE SET
                        recipient_kind = excluded.recipient_kind,
                        encrypted_key = excluded.encrypted_key
                    "#,
                )
                .bind(folder_id)
                .bind(recipient_id)
                .bind(recipient_kind)
                .bind(encrypted_key)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        "FILE_SHARD_MANIFEST" => {
            // Authenticated per-shard hashes (audit #22). The device that
            // encrypted the file signs them, so the node can reject bytes a
            // compromised Relay substitutes before first delivery.
            apply_shard_manifest_conn(&mut tx, event).await?;
        }

        "CONFLICT_RESOLVED" => {
            // ADR-0003: the user resolved a file's conflicted copy. Mark its
            // flagged versions resolved so the local conflict report/listing
            // matches the Relay and the web inbox; version data is retained.
            let file_id = event
                .payload
                .get("file_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !file_id.is_empty() {
                sqlx::query(
                    "UPDATE file_versions SET conflict_status = 'resolved' \
                     WHERE file_id = ? AND conflict_status = 'flagged'",
                )
                .bind(file_id)
                .execute(&mut *tx)
                .await?;
            }
        }

        "FILE_DELETED" | "TOMBSTONE_CREATED" => {
            let entity_id = event
                .payload
                .get("entity_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let entity_type = event
                .payload
                .get("entity_type")
                .and_then(|v| v.as_str())
                .unwrap_or("file");

            if !entity_id.is_empty() {
                sqlx::query(
                    r#"
                    INSERT INTO tombstones (entity_type, entity_id, deleted_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
                    "#,
                )
                .bind(entity_type)
                .bind(entity_id)
                .bind(&event.timestamp)
                .execute(&mut *tx)
                .await?;
            }
        }

        "TOMBSTONE_REMOVED" => {
            // Restore (§17): drop the tombstone so retention GC no longer purges
            // the entity's retained data. Previously this canonical event had no
            // arm and fell through to `_`, so it was acked and the cursor
            // advanced while the tombstone stayed — an offline restore was
            // silently lost and GC purged the data at the 90-day deadline.
            let entity_id = event
                .payload
                .get("entity_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let entity_type = event
                .payload
                .get("entity_type")
                .and_then(|v| v.as_str())
                .unwrap_or("file");

            if !entity_id.is_empty() {
                sqlx::query("DELETE FROM tombstones WHERE entity_type = ? AND entity_id = ?")
                    .bind(entity_type)
                    .bind(entity_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }

        _ => {}
    }

    // 4. Update sync_cursors for the origin peer
    sqlx::query(
        r#"
        INSERT INTO sync_cursors (peer_id, last_sequence_seen, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_sequence_seen = MAX(sync_cursors.last_sequence_seen, excluded.last_sequence_seen),
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&event.origin_id)
    .bind(event.origin_sequence)
    .bind(&event.timestamp)
    .execute(&mut *tx)
    .await?;

    let _ = local_node_id;

    tx.commit().await?;
    Ok(outcome)
}

/// Phase 10: move shards that were fetched from the Relay buffer (Path C) into
/// the real `shards` table now that `file_versions` has the FK target. Ran
/// idempotently after every FILE_VERSION_ADDED / FILE_MODIFIED; already-drained
/// rows are no-ops and duplicates collapse via ON CONFLICT DO NOTHING.
pub(crate) async fn drain_pending_fetches(
    db: &SqlitePool,
    file_id: &str,
    version_number: i64,
) -> anyhow::Result<()> {
    let mut conn = db.acquire().await?;
    drain_pending_fetches_conn(&mut conn, file_id, version_number).await
}

/// Connection variant of [`drain_pending_fetches`]: runs on the caller's
/// transaction so the drain is atomic with the version projection that
/// triggered it (#6).
pub(crate) async fn drain_pending_fetches_conn(
    conn: &mut SqliteConnection,
    file_id: &str,
    version_number: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes)
        SELECT file_id, version_number, shard_index, object_id, size_bytes
        FROM pending_shard_fetches
        WHERE file_id = ? AND version_number = ?
        ON CONFLICT(file_id, version_number, shard_index) DO NOTHING
        "#,
    )
    .bind(file_id)
    .bind(version_number)
    .execute(&mut *conn)
    .await?;

    // Whatever was not drained (e.g. duplicate shard_index already present)
    // is no longer needed in the landing zone.
    sqlx::query("DELETE FROM pending_shard_fetches WHERE file_id = ? AND version_number = ?")
        .bind(file_id)
        .bind(version_number)
        .execute(&mut *conn)
        .await?;

    Ok(())
}

/// Apply a batch of incoming events from Relay and build the BATCH_ACK.
pub async fn apply_incoming_batch(
    db: &SqlitePool,
    batch: &EventBatchPayload,
    local_node_id: &str,
) -> anyhow::Result<BatchAckPayload> {
    let mut applied_ids = Vec::with_capacity(batch.events.len());

    // One connection for the whole batch; each event still commits atomically
    // (see apply_remote_event_conn).
    let mut conn = db.acquire().await?;
    for event in &batch.events {
        match apply_remote_event_conn(&mut conn, event, local_node_id).await {
            Ok(_) => {
                // Both Applied and AlreadyApplied are considered successful delivery
                applied_ids.push(event.event_id.clone());
            }
            Err(e) => {
                if e.downcast_ref::<MalformedEvent>().is_some() {
                    // Deterministically bad payload: retrying cannot help and
                    // would block every later event from this origin, so ack it
                    // (skip) while logging for operators.
                    eprintln!("[sync] skipping malformed event {}: {}", event.event_id, e);
                    applied_ids.push(event.event_id.clone());
                } else {
                    // Transient (e.g. DB busy, FK race): leave it unacked so the
                    // Relay resends the batch.
                    eprintln!("failed to apply event {}: {}", event.event_id, e);
                }
            }
        }
    }

    Ok(BatchAckPayload {
        batch_id: None,
        applied_event_ids: applied_ids,
        // Node-originated acks never carry the device-only fields.
        ok: None,
        reason: None,
        last_origin_sequence: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use sqlx::Row;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_apply_event_idempotency() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let event = SyncEvent {
            event_id: "evt-apply-1".to_string(),
            origin_id: "relay-1".to_string(),
            origin_sequence: 10,
            event_type: "FILE_CREATED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-100",
                "encrypted_name": "photo.jpg"
            }),
            timestamp: "2026-09-04T12:00:00Z".to_string(),
        };

        // First application -> Applied
        let res1 = apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();
        assert_eq!(res1, ApplyOutcome::Applied);

        // Second application with same event -> AlreadyApplied
        let res2 = apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();
        assert_eq!(res2, ApplyOutcome::AlreadyApplied);

        // Batch application
        let batch = EventBatchPayload {
            events: vec![event.clone()],
        };
        let ack = apply_incoming_batch(&pool, &batch, "node-test")
            .await
            .unwrap();
        assert_eq!(ack.applied_event_ids, vec!["evt-apply-1"]);
    }

    #[tokio::test]
    async fn test_apply_folder_events() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let created = SyncEvent {
            event_id: "evt-folder-created".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 1,
            event_type: "FOLDER_CREATED".to_string(),
            payload: serde_json::json!({
                "folder_id": "dir-1",
                "parent_folder_id": null,
                "encrypted_name": "enc"
            }),
            timestamp: "2026-09-12T12:00:00Z".to_string(),
        };
        assert_eq!(
            apply_remote_event(&pool, &created, "node-test")
                .await
                .unwrap(),
            ApplyOutcome::Applied
        );

        let name: String =
            sqlx::query_scalar("SELECT encrypted_name FROM folders WHERE folder_id = 'dir-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(name, "enc");

        let deleted = SyncEvent {
            event_id: "evt-folder-deleted".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 2,
            event_type: "FOLDER_DELETED".to_string(),
            payload: serde_json::json!({ "folder_id": "dir-1" }),
            timestamp: "2026-09-12T12:01:00Z".to_string(),
        };
        apply_remote_event(&pool, &deleted, "node-test")
            .await
            .unwrap();

        let tombstoned: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE entity_type = 'folder' AND entity_id = 'dir-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstoned, 1);
    }

    #[tokio::test]
    async fn test_tombstone_removed_deletes_tombstone() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let created = SyncEvent {
            event_id: "evt-tomb-create".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 1,
            event_type: "TOMBSTONE_CREATED".to_string(),
            payload: serde_json::json!({ "entity_type": "file", "entity_id": "file-9" }),
            timestamp: "2026-09-13T12:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &created, "node-test")
            .await
            .unwrap();

        let removed = SyncEvent {
            event_id: "evt-tomb-removed".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 2,
            event_type: "TOMBSTONE_REMOVED".to_string(),
            payload: serde_json::json!({ "entity_type": "file", "entity_id": "file-9" }),
            timestamp: "2026-09-13T12:05:00Z".to_string(),
        };
        assert_eq!(
            apply_remote_event(&pool, &removed, "node-test")
                .await
                .unwrap(),
            ApplyOutcome::Applied
        );

        // Restore must actually clear the row so retention GC does not purge
        // the retained data at the original 90-day deadline.
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE entity_type = 'file' AND entity_id = 'file-9'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remaining, 0, "TOMBSTONE_REMOVED must delete the tombstone");
    }

    #[tokio::test]
    async fn malformed_known_event_is_skipped_not_blocked() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // `version_number` must be an integer; a string fails deserialization.
        let bad = SyncEvent {
            event_id: "evt-bad".to_string(),
            origin_id: "relay-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({ "file_id": "f", "version_number": "nope" }),
            timestamp: "2026-09-13T00:00:00Z".to_string(),
        };

        let err = apply_remote_event(&pool, &bad, "node-test")
            .await
            .unwrap_err();
        assert!(err.downcast_ref::<MalformedEvent>().is_some());

        // The batch acks/skips it, so a single poison event cannot block the
        // origin's stream forever.
        let batch = EventBatchPayload {
            events: vec![bad.clone()],
        };
        let ack = apply_incoming_batch(&pool, &batch, "node-test")
            .await
            .unwrap();
        assert_eq!(ack.applied_event_ids, vec!["evt-bad"]);
    }

    /// Build a signed `FILE_SHARD_MANIFEST` for `(file_id, version, hashes)`.
    fn signed_manifest(
        signing: &ed25519_dalek::SigningKey,
        device_id: &str,
        file_id: &str,
        version: i64,
        hashes: &[String],
    ) -> SyncEvent {
        use ed25519_dalek::Signer;
        let manifest_hash = blake3::hash(hashes.join(",").as_bytes())
            .to_hex()
            .to_string();
        let message = format!("nodus-shard-manifest:v1:{file_id}:{version}:{manifest_hash}");
        let signature = hex::encode(signing.sign(message.as_bytes()).to_bytes());
        SyncEvent {
            event_id: format!("evt-manifest-{file_id}-{version}"),
            origin_id: device_id.to_string(),
            origin_sequence: 1,
            event_type: "FILE_SHARD_MANIFEST".to_string(),
            payload: serde_json::json!({
                "file_id": file_id,
                "version_number": version,
                "shard_hashes": hashes,
                "signature": signature,
            }),
            timestamp: "2026-09-13T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn conflict_resolved_marks_flagged_versions_resolved() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f1','now','now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // One flagged (conflicted) and one clean version.
        for (version, status) in [(1_i64, "none"), (2_i64, "flagged")] {
            sqlx::query(
                "INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at) \
                 VALUES ('f1', ?, ?, 'h', 1, 'now')",
            )
            .bind(version)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        }

        let event = SyncEvent {
            event_id: "evt-resolve".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 1,
            event_type: "CONFLICT_RESOLVED".to_string(),
            payload: serde_json::json!({ "file_id": "f1" }),
            timestamp: "2026-09-13T00:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let statuses: Vec<(i64, String)> = sqlx::query_as(
            "SELECT version_number, conflict_status FROM file_versions WHERE file_id = 'f1' ORDER BY version_number",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            statuses,
            vec![(1, "none".to_string()), (2, "resolved".to_string())],
            "flagged versions become resolved; clean versions are untouched"
        );
    }

    #[tokio::test]
    async fn shard_manifest_verifies_signature_and_records_hashes() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = signing.verifying_key().to_bytes();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at, paired_at) \
             VALUES ('dev-1', ?, 'ACTIVE', 'now', 'now')",
        )
        .bind(&pubkey[..])
        .execute(&pool)
        .await
        .unwrap();

        let hashes = vec!["a".repeat(64), "b".repeat(64)];
        let event = signed_manifest(&signing, "dev-1", "f1", 1, &hashes);
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let stored: Vec<String> = sqlx::query_scalar(
            "SELECT shard_hash FROM file_version_shard_hashes \
             WHERE file_id = 'f1' AND version_number = 1 ORDER BY shard_index",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(stored, hashes);
    }

    #[tokio::test]
    async fn shard_manifest_with_bad_signature_is_ignored() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = signing.verifying_key().to_bytes();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at, paired_at) \
             VALUES ('dev-1', ?, 'ACTIVE', 'now', 'now')",
        )
        .bind(&pubkey[..])
        .execute(&pool)
        .await
        .unwrap();

        let hashes = vec!["a".repeat(64)];
        let mut event = signed_manifest(&signing, "dev-1", "f1", 1, &hashes);
        // Replace the signature with a forged one (valid shape, wrong key).
        let forged = ed25519_dalek::SigningKey::from_bytes(&[10u8; 32]);
        use ed25519_dalek::Signer;
        let manifest_hash = blake3::hash(hashes.join(",").as_bytes())
            .to_hex()
            .to_string();
        let message = format!("nodus-shard-manifest:v1:f1:1:{manifest_hash}");
        event.payload["signature"] =
            serde_json::json!(hex::encode(forged.sign(message.as_bytes()).to_bytes()));
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_version_shard_hashes")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(stored, 0, "a forged manifest must not be trusted");
    }

    #[tokio::test]
    async fn shard_manifest_marks_mismatched_stored_shard_degraded() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let signing = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = signing.verifying_key().to_bytes();
        sqlx::query(
            "INSERT INTO devices (device_id, public_key_bytes, status, created_at, paired_at) \
             VALUES ('dev-1', ?, 'ACTIVE', 'now', 'now')",
        )
        .bind(&pubkey[..])
        .execute(&pool)
        .await
        .unwrap();

        let wrong = "c".repeat(64);
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) \
             VALUES (?, 1, 'STORED', 'now')",
        )
        .bind(&wrong)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO files (file_id, created_at, updated_at) VALUES ('f1','now','now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO file_versions (file_id, version_number, version_hash, shard_count, created_at) \
             VALUES ('f1', 1, 'vh', 1, 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shards (file_id, version_number, shard_index, object_id, size_bytes) \
             VALUES ('f1', 1, 0, ?, 1)",
        )
        .bind(&wrong)
        .execute(&pool)
        .await
        .unwrap();

        let hashes = vec!["a".repeat(64)];
        let event = signed_manifest(&signing, "dev-1", "f1", 1, &hashes);
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let (status,): (String,) =
            sqlx::query_as("SELECT status FROM storage_objects WHERE object_id = ?")
                .bind(&wrong)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "DEGRADED");
    }

    #[tokio::test]
    async fn test_apply_folder_key_envelope_event() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let event = SyncEvent {
            event_id: "evt-folderenv-1".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 1,
            event_type: "FOLDER_KEY_ENVELOPE_ADDED".to_string(),
            payload: serde_json::json!({
                "folder_id": "dir-1",
                "recipient_id": "device-2",
                "recipient_kind": "device",
                "encrypted_key": "opaque"
            }),
            timestamp: "2026-09-12T12:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let stored: String = sqlx::query_scalar(
            "SELECT encrypted_key FROM folder_key_envelopes WHERE folder_id = 'dir-1' AND recipient_id = 'device-2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, "opaque");
    }

    #[tokio::test]
    async fn test_apply_key_envelope_event() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        let event = SyncEvent {
            event_id: "evt-env-1".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 1,
            event_type: "KEY_ENVELOPE_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-1",
                "recipient_id": "device-2",
                "recipient_kind": "device",
                "encrypted_key": "opaque"
            }),
            timestamp: "2026-09-12T12:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &event, "node-test")
            .await
            .unwrap();

        let stored: String = sqlx::query_scalar(
            "SELECT encrypted_key FROM key_envelopes WHERE file_id = 'file-1' AND recipient_id = 'device-2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, "opaque");

        // A re-seal overwrites in place (same PK).
        let reseal = SyncEvent {
            event_id: "evt-env-2".to_string(),
            origin_id: "device-1".to_string(),
            origin_sequence: 2,
            event_type: "KEY_ENVELOPE_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-1",
                "recipient_id": "device-2",
                "recipient_kind": "device",
                "encrypted_key": "newer"
            }),
            timestamp: "2026-09-12T12:01:00Z".to_string(),
        };
        apply_remote_event(&pool, &reseal, "node-test")
            .await
            .unwrap();
        let stored: String = sqlx::query_scalar(
            "SELECT encrypted_key FROM key_envelopes WHERE file_id = 'file-1' AND recipient_id = 'device-2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, "newer");
    }

    #[tokio::test]
    async fn test_apply_event_conflict_detection() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // 1. Base version A (version 1, parent NULL)
        let evt_a = SyncEvent {
            event_id: "evt-a".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 1,
                "parent_version_id": null,
                "shard_count": 1,
                "version_hash": "hash_a",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T10:00:00Z".to_string(),
        };
        apply_remote_event(&pool, &evt_a, "node-1").await.unwrap();

        // 2. Offline branch version B (version 2, parent 1)
        let evt_b = SyncEvent {
            event_id: "evt-b".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 2,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 2,
                "parent_version_id": 1,
                "shard_count": 1,
                "version_hash": "hash_b",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T11:00:00Z".to_string(),
        };
        let res_b = apply_remote_event(&pool, &evt_b, "node-1").await.unwrap();
        assert_eq!(res_b, ApplyOutcome::Applied);

        // 3. Concurrent branch version D from Relay (version 3, also parent 1!)
        let evt_d = SyncEvent {
            event_id: "evt-d".to_string(),
            origin_id: "relay-origin".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-diverge",
                "version_number": 3,
                "parent_version_id": 1,
                "shard_count": 1,
                "version_hash": "hash_d",
                "encrypted_name": "report.docx"
            }),
            timestamp: "2026-09-04T11:30:00Z".to_string(),
        };

        let res_d = apply_remote_event(&pool, &evt_d, "node-1").await.unwrap();
        match res_d {
            ApplyOutcome::Conflicted {
                conflicted_filename,
                sibling_version,
            } => {
                assert!(conflicted_filename.contains("conflicted copy"));
                assert_eq!(sibling_version, 2);
            }
            other => panic!("expected Conflicted outcome, got {:?}", other),
        }

        // Check both versions remain durable in SQLite
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = 'f-diverge'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 3); // Versions 1, 2, 3 all exist!

        // #10: the conflicted state must persist on the node — the earlier
        // sibling (2) and the incoming (3) are symmetrically flagged, matching
        // the Relay's behavior, so a later snapshot/rebuild keeps the flag.
        let flags: Vec<String> = sqlx::query_scalar(
            "SELECT conflict_status FROM file_versions WHERE file_id = 'f-diverge' ORDER BY version_number",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(flags, vec!["none", "flagged", "flagged"]); // 1 clean; 2 & 3 flagged
    }

    #[tokio::test]
    async fn test_apply_event_fork_collision_preserves_both() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // Base version 1.
        let evt_base = SyncEvent {
            event_id: "evt-base".to_string(),
            origin_id: "node-1".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-fork",
                "version_number": 1,
                "parent_version_id": null,
                "shard_count": 1,
                "version_hash": "hash_base",
                "encrypted_name": "notes.txt"
            }),
            timestamp: "2026-09-04T10:00:00Z".to_string(),
        };
        assert_eq!(
            apply_remote_event(&pool, &evt_base, "node-1")
                .await
                .unwrap(),
            ApplyOutcome::Applied
        );

        // Device A offline: versions 2 (parent 1) then 4 (parent 2).
        for evt in [
            SyncEvent {
                event_id: "evt-a2".to_string(),
                origin_id: "device-a".to_string(),
                origin_sequence: 1,
                event_type: "FILE_VERSION_ADDED".to_string(),
                payload: serde_json::json!({
                    "file_id": "f-fork",
                    "version_number": 2,
                    "parent_version_id": 1,
                    "shard_count": 1,
                    "version_hash": "hash_a2",
                    "encrypted_name": "notes.txt"
                }),
                timestamp: "2026-09-04T11:00:00Z".to_string(),
            },
            SyncEvent {
                event_id: "evt-a4".to_string(),
                origin_id: "device-a".to_string(),
                origin_sequence: 2,
                event_type: "FILE_VERSION_ADDED".to_string(),
                payload: serde_json::json!({
                    "file_id": "f-fork",
                    "version_number": 4,
                    "parent_version_id": 2,
                    "shard_count": 1,
                    "version_hash": "hash_a4",
                    "encrypted_name": "notes.txt"
                }),
                timestamp: "2026-09-04T12:00:00Z".to_string(),
            },
        ] {
            assert_eq!(
                apply_remote_event(&pool, &evt, "node-1").await.unwrap(),
                ApplyOutcome::Applied
            );
        }

        // A shard for A's version 4 already has a pending fetch that must track
        // the version onto its slot.
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('obj-fork', 64, 'STORED', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO pending_shard_fetches
                (file_id, version_number, shard_index, object_id, size_bytes, fetched_at)
            VALUES ('f-fork', 4, 0, 'obj-fork', 64, 'now')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Device B reuses version 4 from the same parent (2) with different
        // content — the canonical offline fork. It must NOT overwrite A's 4.
        let evt_b4 = SyncEvent {
            event_id: "evt-b4".to_string(),
            origin_id: "device-b".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "f-fork",
                "version_number": 4,
                "parent_version_id": 2,
                "shard_count": 1,
                "version_hash": "hash_b4",
                "encrypted_name": "notes.txt"
            }),
            timestamp: "2026-09-04T12:30:00Z".to_string(),
        };
        let res = apply_remote_event(&pool, &evt_b4, "node-1").await.unwrap();
        match res {
            ApplyOutcome::Conflicted {
                conflicted_filename,
                sibling_version,
            } => {
                assert!(conflicted_filename.contains("conflicted copy"));
                assert_eq!(sibling_version, 4);
            }
            other => panic!("expected Conflicted outcome, got {:?}", other),
        }

        // Both branches survive: A's 4 (hash_a4) and B's copy renumbered to 5.
        let rows = sqlx::query(
            "SELECT version_number, parent_version_id, version_hash, conflict_status FROM file_versions WHERE file_id = 'f-fork' ORDER BY version_number",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let versions: Vec<(i64, Option<i64>, String, String)> = rows
            .iter()
            .map(|r| {
                (
                    r.get::<i64, _>("version_number"),
                    r.get::<Option<i64>, _>("parent_version_id"),
                    r.get::<String, _>("version_hash"),
                    r.get::<String, _>("conflict_status"),
                )
            })
            .collect();
        assert_eq!(versions.len(), 4);
        assert_eq!(
            versions[2],
            (4, Some(2), "hash_a4".into(), "flagged".into())
        );
        assert_eq!(
            versions[3],
            (5, Some(2), "hash_b4".into(), "flagged".into())
        );

        // The ADR-0003 conflicted name is persisted on the preserved sibling,
        // not merely returned in the outcome.
        let conflicted: Option<String> = sqlx::query_scalar(
            "SELECT conflicted_name FROM file_versions WHERE file_id = 'f-fork' AND version_number = 5",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            conflicted
                .as_deref()
                .is_some_and(|n| n.contains("conflicted copy")),
            "conflicted_name must be persisted, got {conflicted:?}"
        );

        // The pending shard for the incoming version followed it to slot 5.
        let shards = sqlx::query(
            "SELECT version_number FROM shards WHERE file_id = 'f-fork' ORDER BY version_number",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(shards.len(), 1);
        assert_eq!(shards[0].get::<i64, _>("version_number"), 5);

        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_shard_fetches WHERE file_id = 'f-fork'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending, 0);

        // Re-delivery stays idempotent.
        assert_eq!(
            apply_remote_event(&pool, &evt_b4, "node-1").await.unwrap(),
            ApplyOutcome::AlreadyApplied
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = 'f-fork'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 4);
    }

    #[tokio::test]
    async fn test_pending_fetch_drains_on_version_added() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // Simulate a Relay-buffer-fetched shard that arrived before the version
        // metadata: object stored, but only in the pending landing zone.
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('obj-1', 256, 'STORED', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO pending_shard_fetches
                (file_id, version_number, shard_index, object_id, size_bytes, fetched_at)
            VALUES ('file-pending', 1, 0, 'obj-1', 256, 'now')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // The FILE_VERSION_ADDED event arrives later and must drain it.
        let event = SyncEvent {
            event_id: "evt-version-1".to_string(),
            origin_id: "relay-origin".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-pending",
                "version_number": 1,
                "parent_version_id": null,
                "shard_count": 1,
                "version_hash": "hash_v1"
            }),
            timestamp: "2026-09-05T10:00:00Z".to_string(),
        };

        let res = apply_remote_event(&pool, &event, "node-1").await.unwrap();
        assert_eq!(res, ApplyOutcome::Applied);

        // Shard now present; pending row gone.
        let shard_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shards WHERE file_id = 'file-pending' AND version_number = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(shard_count, 1);

        let pending_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_shard_fetches WHERE file_id = 'file-pending'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending_count, 0);
    }

    #[tokio::test]
    async fn test_projection_failure_rolls_back_whole_event() {
        let dir = tempdir().unwrap();
        let pool = db::open(dir.path()).await.unwrap();

        // A shard sits in the pending landing zone, but the storage object it
        // references does not exist. When the version event arrives, the drain
        // INSERT...SELECT hits the shards.object_id FK and fails mid-event.
        sqlx::query(
            r#"
            INSERT INTO pending_shard_fetches
                (file_id, version_number, shard_index, object_id, size_bytes, fetched_at)
            VALUES ('file-atomic', 1, 0, 'obj-missing', 10, 'now')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let event = SyncEvent {
            event_id: "evt-atomic".to_string(),
            origin_id: "relay-origin".to_string(),
            origin_sequence: 1,
            event_type: "FILE_VERSION_ADDED".to_string(),
            payload: serde_json::json!({
                "file_id": "file-atomic",
                "version_number": 1,
                "parent_version_id": null,
                "shard_count": 1,
                "version_hash": "hash_v1"
            }),
            timestamp: "2026-09-05T10:00:00Z".to_string(),
        };

        // The projection fails, so the whole event must roll back: no files
        // row, no file_versions row, no sync_events entry, no cursor.
        assert!(apply_remote_event(&pool, &event, "node-1").await.is_err());

        let files: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE file_id = 'file-atomic'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(files, 0);

        let versions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = 'file-atomic'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(versions, 0);

        let events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_events WHERE event_id = 'evt-atomic'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(events, 0);

        let cursors: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_cursors WHERE peer_id = 'relay-origin'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cursors, 0);

        // Healing the root cause lets the same event apply cleanly on retry —
        // the rollback did not "burn" the idempotency check.
        sqlx::query(
            "INSERT INTO storage_objects (object_id, size_bytes, status, created_at) VALUES ('obj-missing', 10, 'STORED', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let res = apply_remote_event(&pool, &event, "node-1").await.unwrap();
        assert_eq!(res, ApplyOutcome::Applied);

        let versions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_versions WHERE file_id = 'file-atomic'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(versions, 1);

        let shards: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM shards WHERE file_id = 'file-atomic'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(shards, 1);
    }
}
