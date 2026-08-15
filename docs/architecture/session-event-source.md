# Session event source architecture

This is the ownership contract for session state after the EventV2 migration.
The event log is the durable source of truth. Projections and notifications are
derived views; a process-local stream is never evidence that data was durably
accepted.

## Ownership matrix

| Structure | Durable source | Who creates or updates it | Rebuild rule | Delete rule |
| --- | --- | --- | --- | --- |
| Versioned EventV2 event | EventV2 event log, keyed by event ID and aggregate sequence | The privileged session/event runtime allocates the event ID and sequence and appends it transactionally | Replay the aggregate's ordered events through the registered projector | Never delete individual events as rollback; retain the log for audit and replay |
| Session projection row | `SessionProjectionTable` / `session_projection` | The compiled `session-message` projector advances it in the same transaction as the projected write | Clear the projector row and replay the event log from sequence `0` | Delete only as part of a full projection rebuild or database retirement |
| Projection watermark | Projector-owned `(aggregate, projector, version, seq)` row | The projector writes the next contiguous sequence after apply or an explicitly ignorable skip | Recreate from the event log and the current projector version | Remove with its projector rows; never edit it to conceal a gap |
| Compatibility session/message view | Legacy tables during the rollout window | The compatibility projector only; application reads move away from it in Release N+1 | Rebuild from EventV2 while parity checks are enabled | Retire only after legacy reads are zero and the rollback window has closed |
| Runtime notification | EventV2 service PubSub and the product bus | The event runtime publishes after the durable transaction commits | Re-subscribe and replay durable events after a gap | Scope shutdown disposes subscriptions; it does not remove durable events |

The four ownership classes are intentionally separate:

- Durable source: the versioned event log and its sequence allocator. Only the
  privileged runtime appends events.
- Projection: the session projector and watermark rows. It is deterministic,
  versioned, and disposable.
- Runtime activity: PubSub subscriptions, bus notifications, and in-memory
  caches. They may be dropped and reconstructed at any time.
- External extension: SDK consumers, provider adapters, MCP tools, and plugin
  subscribers. They may observe a published event through a documented port,
  but cannot append to the log or mutate a projection table.

## Invariants and recovery

Every aggregate projection consumes contiguous sequence numbers. A gap,
unknown required event, or projector-version mismatch stops the projector and
creates an operator-visible recovery condition. Ignorable events may advance
the watermark without changing the view. Replaying an already consumed
sequence is idempotent; replaying a different payload with the same event ID
is rejected.

`SyncEvent.replay` and `SyncEvent.rebuild` are compatibility entry points while
the rollout is in progress. They must use the same transaction, projector, and
watermark rules as normal EventV2 writes. They are not a second source of
truth. A projection repair records the aggregate, projector version, start
sequence, end sequence, and outcome, but never records prompts, credentials, or
complete tool output.

## Operational contract

Before changing a projector, run replay/parity checks against a copy of the
database. Keep the event log and blob root as a matched backup pair. If a
projection rebuild fails, preserve the failed projection and restore the
database copy or run the prior binary against the compatibility projection;
never destructively rewind the event log.
