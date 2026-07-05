# Agent Cluster Runtime

The Agent Cluster runtime converts Jyy-Code Multi-Agent from prompt-driven orchestration into a deterministic, recoverable runtime with enforced scheduling, real review/revision loops, accurate UI state, and live user guidance for child agents.

## Architecture

SQLite rows are the authoritative source of truth for plans, task lifecycle, reviews, interventions, and run completion. A runtime coordinator validates and schedules tasks, background-job completion submits results, a configured reviewer model returns schema-validated decisions, and only accepted tasks unlock dependents.

## Task Identity

Each task has two identifiers:
- `id` (ULID): globally unique, used for database/event identity
- `plan_task_id` (string): planner-visible key, unique only within one run

A unique index on `(run_id, plan_task_id)` enforces per-run uniqueness.

## Task State Machine

```
planned -> queued
queued -> running | cancelled | failed
running -> submitted | failed | cancelled
submitted -> reviewing | failed | cancelled
reviewing -> accepted | revision_requested | failed | cancelled
revision_requested -> revising | failed | cancelled
revising -> submitted | failed | cancelled
```

Terminal states: `accepted`, `failed`, `cancelled`.

## Run State Derivation

- `planning`: no validated plan submitted
- `dispatching`: at least one task is queued/running/revising
- `reviewing`: no runnable work, at least one task is submitted/reviewing/revision_requested
- `completed`: all tasks terminal with at least one accepted
- `failed`: all tasks failed/cancelled with no accepted
- `cancelled`: user explicitly cancelled

## Dependencies

Dependencies are satisfied only by `accepted`. A merely completed/submitted task must not unlock downstream work. Failed dependencies block dependents.

## Review Process

1. Task result is submitted via background job completion bridge
2. Runtime runs deterministic artifact prechecks (path safety, file existence, hashing)
3. Configured reviewer model is called with structured output (`ReviewDecision` schema)
4. Missing required artifacts cannot result in `accepted`
5. `revision_requested` requires a non-empty `revisionPrompt`

## Revision

- Reuses the exact same `child_session_id`
- Round limit enforced transactionally
- Original task context is preserved
- Revision prompt is appended before the next model iteration
- Exceeding `max_review_rounds` transitions to `failed`

## Intervention Delivery

User guidance for child agents is delivered through a persisted intervention mailbox:

- `next_checkpoint`: append guidance before the next model iteration
- `interrupt`: cancel active inference, append guidance, resume (after `next_checkpoint` is stable)
- `parent_only`: notify coordinator without changing child prompt

States: `queued -> delivered -> acknowledged` (or `rejected`/`cancelled`)

No two loops may run concurrently in the same child session.

## Concurrency

- `max_concurrency` is global per run (not per step)
- `max_subagents` counts persisted plan tasks
- Tasks count toward concurrency while `running` or `revising`

## Restart Recovery

On restart, the recovery service:
- Resets `reviewing` tasks to `submitted` for re-review
- Marks orphaned `running`/`revising` tasks as `failed`
- Re-derives run status from task states
- Publishes versioned recovery events

## Operational Limits

- `max_subagents`: maximum plan tasks per run (default: 100)
- `max_concurrency`: maximum concurrent running/revising tasks (default: 10)
- `max_review_rounds`: maximum revision rounds per task (default: 3)
