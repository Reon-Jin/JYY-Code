# Agent Isolation Architecture

Each standard dispatched Task receives a workspace capability selected from the project type.

| Project | Default workspace | Write behavior |
| --- | --- | --- |
| Git project | detached Git Worktree | Child writes stay in the worktree until the parent reviews the result |
| Non-Git project | writable snapshot under the runtime workspace | Child writes stay in the snapshot and are tracked against a baseline manifest |
| Explicit compatibility mode | `shared_compat` | Child writes the project workspace directly; this is an opt-in risk |

Workspace names are deterministic for a root session and Task. The persisted Dispatch record includes the mode, root, directory, creation time, cleanup policy, and lifecycle; the workspace manager keeps a baseline manifest for snapshot diffing. Paths are canonicalized and constrained to the intended workspace root.

## Artifact rules

Standard Task `output_path` values are resolved against the parent workspace root before dispatch. A child brief carries the resolved workspace and output path for the child workspace. Reports must reference existing artifacts inside the Task output subtree; absolute paths, traversal, symlinks, and look-alike directory escapes are rejected.

The parent plan root is a separate runtime boundary from the child workspace. Child-facing plan tools receive that root through runtime metadata and use it only for plan state, run lookup, and candidate protocol files; ordinary filesystem tools and standard Report artifacts remain constrained to the child workspace. Candidate proposal files are the intentional exception: `Candidate_submit` writes only the candidate's runtime-assigned `proposal.md` below the parent plan's candidate directory, never an arbitrary parent-worktree path.

Candidate Tasks use their own proposal path under the plan directory and submit with `Candidate_submit`. They do not write to the parent worktree during isolated execution.

## Merge contract

The standard lifecycle is `Report -> review_task(approve) -> Merge.apply -> merged -> child/baseline cleanup`.

`Merge.apply` is the single integration contract for both isolated Git Worktrees and non-Git snapshots. The normal main-Agent call is:

```json
{"task_id":"s1_t1"}
```

The runtime compares the immutable dispatch baseline, the current parent workspace, and the child workspace. Non-overlapping changes are applied automatically. A true conflict is left untouched and returned as a bounded summary. The main Agent inspects the reported `main_path`, edits the parent when needed, and retries with an explicit choice:

```json
{"task_id":"s1_t1","resolutions":[{"path":"src/config.ts","use":"main"}]}
```

`use:"main"` keeps the current parent bytes; `use:"child"` explicitly replaces them with the child version. Candidate Tasks keep their proposal workflow, and `shared_compat` records integration as already applied without copying the parent onto itself. Plan JSON stores paths, hashes, statuses, and bounded summaries; merge journals and file contents remain in the exact recorded runtime sidecar.

## Cleanup and failure handling

Worktree and snapshot metadata are retained in the plan so cleanup can be targeted to the exact directory. Cancellation, child-start failure, and recovery rejection attempt to terminate the child and remove the recorded isolated workspace. Cleanup failures are surfaced in Inbox and runtime metrics rather than silently deleting an unrelated directory. `shared_compat` points at the project root and is never removed by workspace cleanup.

When investigating a failed Task, preserve the recorded Worktree or snapshot until its artifacts and diff have been reviewed. Remove it only through the recorded Dispatch metadata or the recovery runbook; do not use a broad recursive delete against the runtime root.
