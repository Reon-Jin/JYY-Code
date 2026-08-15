# Process runtime architecture

All product subprocesses pass through the privileged process runtime. Native
process APIs are limited to platform adapters and test harnesses. A provider,
plugin, or project tool receives a declarative process port and never receives
an OS process handle.

## Ownership matrix

| Structure | Owner | Create/update contract | Rebuild or recovery | Delete/cleanup |
| --- | --- | --- | --- | --- |
| `AppProcessHandle` | `AppProcess.Service` | The service creates the child from a bounded command spec and owns termination | A handle cannot be rebuilt; reconnect through the durable owner or mark the activity unknown | Scope disposal terminates live handles; callers must await the termination result |
| `BackgroundProcess.Info` | `BackgroundProcess.Service` | `start` creates the runtime row; output, deadline, exit, and termination transitions update it | Reconcile the owning session and use the recorded status; a missing live handle is not treated as success | Remove in-memory activity after terminal output is flushed; retain `kill_failed` details for recovery |
| Output retention | `OutputRetention` plus blob store | The process runtime appends bounded chunks, tracks bytes and hash, and spills only after truncation | Reopen the recorded blob reference, or retry a failed stream without losing the retryable state | Delete a spill only after the owner is terminal and no reader/repair references it |
| Deadline/watchdog | `BackgroundProcess.Service` | Start records `deadline_at`; the watchdog requests graceful termination, then force termination | A restart rechecks the deadline and marks an unresolvable live child for operator review | Stop the watchdog when the process reaches a terminal state |
| External extension | Tool/provider/MCP adapter | It requests a command through `AppProcess` or a background job and receives bounded output | It may retry a declarative request with a new runtime ID; it cannot revive an old handle | The runtime, not the extension, owns cancellation and process-tree cleanup |

## Status and failure semantics

The durable-facing status set is explicit: `running`, `completed`, `error`,
`cancelled`, `timed_out`, and `kill_failed`. `kill_failed` is not silently
converted to `cancelled`: the handle and bounded termination detail remain
available so recovery can retry or request human intervention.

Output is byte-bounded. The runtime exposes a preview and metadata such as
`bytesSeen`, `bytesRetained`, `truncated`, `sha256`, and an optional blob
reference. Prompts, secrets, complete output, and provider error bodies do not
belong in process status, events, or telemetry.

Parent shutdown is a barrier:

```text
stop new work -> mark owners draining -> terminate children -> flush output
              -> settle durable ownership -> remove workspaces -> parent terminal
```

Workspace removal is allowed only after the durable child activation is
settled. A failed termination or cleanup leaves the exact recorded runtime
root recoverable; broad directory scans and unconditional recursive deletion
are not valid recovery mechanisms.
