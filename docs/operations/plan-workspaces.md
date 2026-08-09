# Plan workspace storage operations

Plan child snapshots and merge journals live below the runtime data directory in `plan-workspaces/<project>`. The `global` namespace is shared by sessions, so inspect it before changing anything.

## Inspect first

```powershell
jyycode debug plan-workspaces inspect --project global --json
jyycode debug plan-workspaces cleanup --project global --dry-run
```

The inventory is bounded and read-only. It reports `active`, `cleanup_failed`, `orphan`, `terminal_reference`, and `unknown` entries with byte and directory counts, lease/session/task identity, a stable cleanup ID, and a reason. Paths are redacted by default; add `--show-paths` only when the operator needs local paths. The first startup that sees a runtime root creates an index and does not clean directories newer than the one-hour orphan grace period.

The dry-run output is the approval boundary. If an entry still needs action, copy its cleanup ID and apply only that ID after reviewing the current plan, session, lease, and identity:

```powershell
jyycode debug plan-workspaces cleanup --project global --apply pw_<id> --json
```

Application renames the exact directory and its sidecars into `.quarantine`; it never deletes the selected directory directly. A later bounded sweeper may remove quarantine entries after the default seven-day retention period.

## Manual boundaries

Do not automate or guess through these states:

- `unknown` entries, missing or invalid manifests, and directories that do not match the generated layout;
- a directory that remains locked after the quarantine retention window;
- a missing process-tree guardian or any `kill_failed` result;
- an identity mismatch between the dry-run inventory and the apply attempt.

Stop the cleanup, preserve the directory, and inspect the error code and operation ID. Take a backup of the runtime root (and the matching session database) before manual intervention. Never run `Remove-Item -Recurse` against the entire global runtime root. If a directory must be removed manually, use the exact quarantined path after confirming it is outside all active lease and plan references.

Telemetry and logs contain bounded counts, ages, phases, error codes, and operation IDs only. They do not contain commands, command output, MCP payloads, memory contents, or tokens.
