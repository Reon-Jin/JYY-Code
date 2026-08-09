# Session storage operations

The storage commands inspect and maintain the local session data root without exposing message or tool bodies by default.

```text
jyycode storage inspect --json
jyycode storage cleanup --dry-run --older-than 30d
jyycode storage gc --dry-run
jyycode storage maintain --database active --dry-run
jyycode storage backfill --dry-run
```

All mutating commands default to dry-run. Use `--no-dry-run` only after reviewing the report. `storage inspect` reports counts and byte totals for sessions, tool payloads, blobs, channel databases, backups, logs, workspaces, and tool-output files. It also reports low-disk and large-root warnings without printing stored content.

Retention is intentionally conservative:

- Root sessions are never automatically deleted.
- Active, leased, permission-waiting, and question-waiting child sessions are preserved.
- An expired terminal child may have large tool payloads pruned, but session deletion remains explicit.
- Unknown database and backup files are reported only.
- A low-disk hard stop blocks new large blob writes; text sessions, export, explicit deletion, and recovery remain available.

`storage gc` uses the blob reference table, a grace period, and lease files before removing unreferenced canonical blobs or stale temporary files. `storage maintain` performs a passive WAL checkpoint and a bounded incremental vacuum. Full `VACUUM INTO` is available only with the explicit `--full` option against an offline database path; it requires free space, an integrity check, a manifest, and an atomic replacement. A busy Windows database is reported as busy and is never forcibly replaced.

`storage backfill` migrates legacy `data:` parts into the content-addressed blob store. It is dry-run by default. An apply run is bounded to 100 parts, 64 MiB, or 30 seconds per batch, and persists a resumable cursor plus a timestamp watermark. Re-running a completed batch is safe; malformed rows are reported and skipped, while the original data URL remains readable until the replacement is committed. Blob garbage collection must remain disabled for the rehearsal and rollback window.

For a rehearsal, stop the application, copy the SQLite database and its session-storage root to a disposable directory, and point the CLI at that copy. Run `storage backfill --dry-run --json`, review the counts and byte estimate, then run the same command with `--no-dry-run`. Keep the original database and blob root unchanged until the copied database passes integrity checks and representative sessions can be opened. To roll back, stop the application and restore the original database/root pair; do not mix a database from one copy with a blob root from another.

The staged rollout controls are `blob_store_write`, `payload_prune`, `reliable_event_hub`, `lazy_mcp`, `lsp_lru`, and `storage_backfill`. Enable them independently, beginning with `blob_store_write` and a dry-run `storage_backfill`; defer `payload_prune` and blob GC until references, recovery, and event durability have been verified.

The hard safety limits are code-defined. Configuration can adjust reporting and retention hints, but an agent cannot raise the global payload or disk safety limits.

The storage soak command exercises deduplication, event backpressure, child-session creation, and MCP/LSP cleanup:

```text
cd packages/jyycode
bun run script/session-storage-soak.ts --sessions 1000 --children 5000 --blob-bytes 1073741824 --events 1000000
```

Run it against a disposable root with an external watchdog. The report must show bounded physical blob bytes, no child-process launches, empty MCP state after sweeping, bounded LSP cache size, and no lossless event-queue overflow.
