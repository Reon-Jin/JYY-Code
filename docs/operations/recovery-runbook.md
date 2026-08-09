# Multi-Agent Recovery Runbook

Use this runbook when a plan appears stuck, a child stopped unexpectedly, or a process was interrupted.

## 1. Identify the plan and read-only state

From the project workspace, inspect the canonical plan directory:

```powershell
$planRoot = Join-Path (Get-Location) ".jyycode\plan"
Get-ChildItem -LiteralPath $planRoot -Recurse -Force
Get-Content -LiteralPath "<workspace>\.jyycode\plan\<root-session-id>\plan.json"
```

Check the task `status`, `dispatch.lifecycle`, `run_id`, `child_session_id`, `workspace`, and `report`. Do not edit `plan.json` by hand while the runtime is active.

For an integration issue, also inspect the Task's `merge` record: `status`, `attempt`, `applied_paths`, bounded `conflicts`, `target_fingerprint`, `cleanup`, `journal_directory`, and `cleanup_error`. The journal is under the exact recorded runtime directory, for example:

```powershell
$plan = Get-Content -Raw -LiteralPath "<workspace>\.jyycode\plan\<root-session-id>\plan.json" | ConvertFrom-Json
$task = $plan.steps | ForEach-Object { $_.tasks } | Where-Object { $_.id -eq "s1_t1" }
$task.merge.journal_directory
Get-ChildItem -LiteralPath $task.merge.journal_directory -Recurse -Force
Get-Content -LiteralPath (Join-Path $task.merge.journal_directory "merge.json")
```

Only inspect the persisted `main_path`, `child_path`, and `base_path` conflict paths. Do not copy complete file contents into Inbox or telemetry.

Inspect the persistent Inbox and event records through the Inbox/Plan tools or the supported database inspection command:

```text
jyycode db status
```

Runtime subscriptions are not durable; after a restart, a missing in-memory wakeup is expected to be recovered from the persisted event/Inbox state.

## 2. Interpret the lifecycle

- `reported`, `approved`, `rejected`, or `dismissed`: treat the task as settled; do not dispatch a second child.
- `running`: verify whether the child session still exists and is not archived. An active child can continue; a missing child is reconciled to `rejected` with an Inbox entry.
- `reserved`, `child_created`, or expired `starting`: inspect the recorded workspace and child session. Startup reconcile will resume only when a resume path is available; otherwise it rejects safely for explicit redispatch.
- `merge.status=running`: preserve the recorded journal and let startup recovery resume it. Do not manually copy child files into the parent.
- `merge.status=conflict`: inspect the bounded conflict summaries, edit the parent with normal tools if appropriate, then retry `Merge.apply` with `resolutions:[{path,use:"main"|"child"}]`. Do not use an implicit prefer-child policy.
- `merge.status=merged` with `cleanup=pending` or `failed`: retry the exact recorded cleanup operation after fixing the workspace service; the parent integration is already durable.
- `plan.json.tmp` or `.bak.*`: do not delete it first. `PlanStore` selects the newest complete candidate and the next successful write cleans old backups.

## 3. Preserve failed isolated workspaces

For a failed Git Worktree or snapshot, record the exact `dispatch.workspace.directory`, inspect the child diff and output artifacts, and keep the directory while triaging. If cleanup previously failed, retry only that exact directory using the Worktree/snapshot service or the child workspace metadata. Never delete the entire runtime workspace.

`shared_compat` uses the project root and must not be removed. Resolve the underlying Task conflict or reopen the terminal Task with an explicit reason before redispatching.

## 4. Safe state actions

Use protocol operations in this order:

1. Read `Plan` and `Inbox`.
2. Resolve or mark Inbox items handled after reviewing their suggested actions.
3. For a live dispatched/running Task, use `Dispatch_cancel` when cancellation is intended.
4. For a reported/approved/rejected/dismissed Task that must run again, use `Plan_update(reopen_task)` with a concrete reason, then dispatch the reopened Task.
5. Retry the same `run_id` only for a retryable Report precheck or revision conflict; never replay a stale run after a replacement dispatch.
6. For a merge conflict, use the same Task ID and a short relative `resolutions` array. Unknown, out-of-scope, or stale resolutions must be rejected without changing the parent.

## 5. Schema or database failures

If a plan fails schema validation, preserve the original `plan.json`, `.tmp`, and backup candidates before any repair. Copy the directory to a dated evidence location, then compare the file with `plan.schema.json` and the current runtime version. Prefer restoring the newest complete candidate through a normal PlanStore write rather than hand-editing JSON.

If a database migration or event-store initialization fails, stop the new runtime, preserve the database together with its `-wal` and `-shm` files, and use `jyycode db status` before attempting repair. Resume only after the migration issue is fixed and the original plan/evidence copy is available.

## 6. What to capture in an incident

Capture session ID, plan revision, Task ID, lifecycle, run ID, workspace mode/directory, Inbox entry IDs, event sequence, and metric phase/outcome. Do not attach prompts, memory contents, provider credentials, secrets, or complete tool output to the incident record.

Never run a recursive delete against the runtime root, plan root, or workspace root. Cleanup must use the exact persisted child/baseline metadata, and `shared_compat` must never be removed by recovery.
