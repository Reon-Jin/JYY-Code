# EventV2 single-source migration

This migration moves session durability from the legacy event/session write
path to versioned EventV2 events while keeping old databases recoverable.

## Release phases

### Release N: compatibility and dual write

- Add EventV2 replay, legacy/EventV2 parity checks, projection watermarks, and
  versioned event catalogs.
- Keep legacy projection writes for old readers while the EventV2 event log is
  appended in the same transaction.
- Record parity failures with aggregate, sequence, projector version, and
  bounded field names only. Do not record prompts, secrets, or complete output.
- Gate rollout on deterministic replay and no sequence-gap or duplicate-ID
  errors for the observation window.

### Release N+1: EventV2 reads and writes

- Read sessions from the EventV2 projection and write only EventV2 events.
- Keep the legacy projection as a compatibility read surface for the prior
  binary and for rollback; it is no longer an application write target.
- Run a one-time inline compatibility decoder for credential references and
  warn when it migrates an inline secret.
- Monitor projection lag, replay failures, parity from the compatibility view,
  and legacy-read counters.

### Release N+2: reject and retire

- Reject inline credential secrets with an actionable configuration error.
- Require telemetry to show zero legacy reads for the agreed observation
  window, with no unresolved parity or replay failures.
- Only then schedule legacy table deletion in a separately backed-up release.

## Old database procedure

1. Stop the application and copy the database together with its `-wal` and
   `-shm` files, blob root, plan roots, and the binary/schema fingerprint.
2. Run `jyycode storage backfill --dry-run --json` and the EventV2 replay/parity
   verifier against the copy. Review counts, sequence gaps, projection
   watermarks, blob references, and legacy-read counters.
3. Apply in bounded batches with the saved watermark/cursor. Re-run the
   validation suite and a representative session replay before switching the
   active database.
4. If validation fails, stop the new binary, preserve its diagnostics, and
   restore the database copy or start the previous binary against the old
   compatibility projection. Do not delete or rewind EventV2 events to make a
   failed projection appear healthy.

Rollback is therefore non-destructive: switch binaries or restore a matched
database copy. It is not an event-log rollback.
