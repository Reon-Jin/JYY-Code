# Plan Recovery Architecture

JYY-Code treats the persisted plan as the source of truth for a multi-agent run. A plan is stored at:

```text
<workspace>/.jyycode/plan/<root-session-id>/plan.json
```

Every accepted mutation is serialized through `PlanStore`, checked against the latest revision, written to a same-directory temporary file, flushed, and then replaced atomically where the platform supports it.

## Replacement and crash recovery

`PlanStore` never unconditionally deletes the only target plan. On Windows-style replacement failure it moves the previous target to a unique `.bak.*` file and then attempts the temporary-to-target handoff. If that second rename fails, both the old backup and the complete `.tmp` remain available.

Reads consider these candidates:

1. `plan.json`
2. `plan.json.tmp`
3. `plan.json.bak` and `plan.json.bak.*`

Malformed candidates are ignored when another complete candidate exists. The newest valid candidate is selected by revision, then `updated_at`, then file modification time. A later successful write removes recoverable backup copies after the new target is in place.

The sidecar lock is `<plan-path>.lock`. Stale-lock reclamation requires both an expired acquisition timestamp and a dead owner PID; an old-looking lock owned by a live process is retained.

## Dispatch lifecycle

Dispatch metadata records the lifecycle independently of the task status:

```text
reserved -> child_created -> starting -> running -> settled
```

The lifecycle is paired with a durable activation lease. `session_id` identifies the child across restarts; `owner_id` identifies the current runtime process, and `generation` is the CAS fence. A process may renew or transition only when both owner and generation match. After `lease_expires_at`, recovery may claim the child with `generation + 1` and records a `child.recovery` event. The previous owner cannot continue execution after that fence changes.

The lifecycle makes partial child creation visible. Recovery can therefore make one of four safe decisions:

- continue a `running` child when its session is still active;
- resume a recoverable early phase when a resume callback is available;
- reject a dead or expired run and create an Inbox entry;
- leave an already reported or terminal task settled and unchanged.

An isolated child has two roots during recovery: its recorded workspace directory and the root plan directory. Re-established child run metadata carries the plan root explicitly, so Report/candidate state lookup does not accidentally read a plan from the child worktree. The workspace root remains the authority for ordinary child artifacts and merge cleanup.

The root session executes startup reconciliation once per process/workspace/session key. In-process plan activity is marked so a dispatch created by the current process is not mistaken for a pre-existing crash on the next turn. Runtime event subscriptions remain process-local; durable event and Inbox records are used for replay and inspection.

Cold start reports durable plan/activation rows separately from live runtime activation. Recovery never treats the presence of `plan.json` or a `plan_activation` row as proof that a model loop is live. A non-expired lease is preserved to avoid double execution; an expired lease is taken over, fenced, and either resumed or rejected after the child liveness check.

## Parent shutdown ordering

Parent shutdown is a child-first barrier:

```text
stop dispatch -> mark children draining -> terminate and settle children
              -> flush merge journals -> clean workspaces -> parent terminal
```

No new dispatch is accepted after the first barrier. Workspace cleanup runs only after child termination has reached its idle/archive contract, so a child cannot write into a directory while its parent removes it.

## Observability

Plan runtime metrics use scalar fields only: metric name, phase, outcome, duration, counts, savings, and retry counts. They intentionally exclude prompts, memory contents, secrets, provider errors, and complete tool output. Recovery actions and final counts are emitted separately so an operator can distinguish a continued child, a rejection, and an already-settled task.

## Merge recovery

An approved isolated Task is not complete until its merge record is `merged`. The merge lifecycle is:

```text
pending -> running -> merged -> cleanup completed
                  \-> conflict -> explicit resolution retry
                  \-> failed  -> preserve journal and workspace
```

`Merge.apply` writes a journal below the recorded runtime root before applying parent changes. On startup, recovery uses only the persisted baseline, child, journal, and workspace metadata: an interrupted `running` journal is resumed, an already-applied journal is settled idempotently, and a conflict preserves both sidecars for inspection. A successful merge is recorded before child/baseline cleanup begins. Cleanup failure leaves `merged` plus `cleanup: failed` and creates a bounded Inbox entry; it never rolls back already-integrated parent files.

Recovery rejects a merge whose dispatch was cancelled or whose recorded paths no longer belong to the owning runtime root. It never scans the runtime directory to infer Task ownership and never attaches file contents to events, Inbox entries, or telemetry.

## Ownership and rollback boundary

Plan recovery separates four ownership classes:

| Class | Owner | Rebuild/delete rule |
| --- | --- | --- |
| Durable source | `PlanStore`, activation store, and merge journal | Re-read the newest valid plan/sidecar; retain the event and journal history. Delete only after the retention policy and terminal cleanup contract permit it |
| Projection | Inbox, recovery report, metrics, and workspace inventory | Recompute from durable plan/activation state; never use a projection to infer a live child |
| Runtime activity | Child process, lease heartbeat, merge worker, and event subscription | Reconnect only after owner/generation validation; settle or fence stale activity before cleanup |
| External extension | Git worktree adapter, filesystem, and model/tool ports | Recreate from recorded metadata or quarantine for review; it cannot rewrite the plan or claim another owner |

For an old database or interrupted migration, make a matched copy of the
database, WAL/SHM files, blob root, plan roots, and merge sidecars first. Run a
dry-run inventory and replay/parity check against the copy. Validate row counts,
contiguous watermarks, activation ownership, blob references, and the absence
of live children before apply. If validation fails, keep the original intact
and restore the copy or run the prior binary against its compatibility
projection. Event logs and already-merged parent files are never destructively
rolled back; rollback is a binary/database-copy choice.
