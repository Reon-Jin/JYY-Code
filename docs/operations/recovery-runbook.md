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

Inspect the persistent Inbox and event records through the Inbox/Plan tools or the supported database inspection command:

```text
jyycode db status
```

Runtime subscriptions are not durable; after a restart, a missing in-memory wakeup is expected to be recovered from the persisted event/Inbox state.

## 2. Interpret the lifecycle

- `reported`, `approved`, `rejected`, or `dismissed`: treat the task as settled; do not dispatch a second child.
- `running`: verify whether the child session still exists and is not archived. An active child can continue; a missing child is reconciled to `rejected` with an Inbox entry.
- `reserved`, `child_created`, or expired `starting`: inspect the recorded workspace and child session. Startup reconcile will resume only when a resume path is available; otherwise it rejects safely for explicit redispatch.
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

## 5. Schema or database failures

If a plan fails schema validation, preserve the original `plan.json`, `.tmp`, and backup candidates before any repair. Copy the directory to a dated evidence location, then compare the file with `plan.schema.json` and the current runtime version. Prefer restoring the newest complete candidate through a normal PlanStore write rather than hand-editing JSON.

If a database migration or event-store initialization fails, stop the new runtime, preserve the database together with its `-wal` and `-shm` files, and use `jyycode db status` before attempting repair. Resume only after the migration issue is fixed and the original plan/evidence copy is available.

## 6. What to capture in an incident

Capture session ID, plan revision, Task ID, lifecycle, run ID, workspace mode/directory, Inbox entry IDs, event sequence, and metric phase/outcome. Do not attach prompts, memory contents, provider credentials, secrets, or complete tool output to the incident record.
