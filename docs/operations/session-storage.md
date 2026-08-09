# Session storage operations

The storage commands inspect and maintain the local session data root without exposing message or tool bodies by default.

```text
jyycode storage inspect --json
jyycode storage cleanup --dry-run --older-than 30d
jyycode storage gc --dry-run
jyycode storage maintain --database active --dry-run
```

All mutating commands default to dry-run. Use `--no-dry-run` only after reviewing the report. `storage inspect` reports counts and byte totals for sessions, tool payloads, blobs, channel databases, backups, logs, workspaces, and tool-output files. It also reports low-disk and large-root warnings without printing stored content.

Retention is intentionally conservative:

- Root sessions are never automatically deleted.
- Active, leased, permission-waiting, and question-waiting child sessions are preserved.
- An expired terminal child may have large tool payloads pruned, but session deletion remains explicit.
- Unknown database and backup files are reported only.
- A low-disk hard stop blocks new large blob writes; text sessions, export, explicit deletion, and recovery remain available.

`storage gc` uses the blob reference table, a grace period, and lease files before removing unreferenced canonical blobs or stale temporary files. `storage maintain` performs a passive WAL checkpoint and a bounded incremental vacuum. Full `VACUUM INTO` is available only with the explicit `--full` option against an offline database path; it requires free space, an integrity check, a manifest, and an atomic replacement. A busy Windows database is reported as busy and is never forcibly replaced.

The hard safety limits are code-defined. Configuration can adjust reporting and retention hints, but an agent cannot raise the global payload or disk safety limits.
