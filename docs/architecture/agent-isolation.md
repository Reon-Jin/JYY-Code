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

Candidate Tasks use their own proposal path under the plan directory and submit with `Candidate_submit`. They do not write to the parent worktree during isolated execution.

## Cleanup and failure handling

Worktree and snapshot metadata are retained in the plan so cleanup can be targeted to the exact directory. Cancellation, child-start failure, and recovery rejection attempt to terminate the child and remove the recorded isolated workspace. Cleanup failures are surfaced in Inbox and runtime metrics rather than silently deleting an unrelated directory. `shared_compat` points at the project root and is never removed by workspace cleanup.

When investigating a failed Task, preserve the recorded Worktree or snapshot until its artifacts and diff have been reviewed. Remove it only through the recorded Dispatch metadata or the recovery runbook; do not use a broad recursive delete against the runtime root.
