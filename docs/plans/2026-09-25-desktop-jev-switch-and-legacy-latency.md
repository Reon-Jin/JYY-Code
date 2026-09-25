# Desktop Jev switch and legacy computer latency

## Goal

Desktop stores a Jev API key securely and switches computer control modes immediately. An active key selects the grounded `choose` path, with no direct-action fallback. Without a key, the existing screenshot and direct-action path remains available. The old path must have bounded waits and responsive cancellation.

## Findings

- Computer permission requests inherit a ten-minute approval timeout. During that wait, no desktop action runs.
- The outer computer transaction queue and the Windows helper queue do not honor cancellation while a request waits its turn. A stalled request can make later requests appear frozen.
- The Windows helper request itself has a 30-second timer, but worker startup and cleanup can extend perceived latency; generic tool execution has a two-minute default budget.
- The existing Jev path is gated by an environment flag and reads an environment key. Desktop has no credential control or reliable mode indicator.

## Implementation

1. Add a public credential-status API that exposes only active/inactive state, then regenerate the SDK.
2. Add a Jev API settings card with password input, activate and deactivate actions. Save through the existing protected auth store and refresh the desktop instance/tool catalog.
3. Resolve mode from stored credentials at tool creation and execution. In Jev mode, expose `choose` and observation, reject direct actions, pass the stored key to Jev, and remove direct-action fallback instructions. In legacy mode, reject `choose` and retain direct actions.
4. Bound computer permission approval to a shorter, explicit period. Make queued work reject promptly on abort, cap native action duration, and avoid waiting for helper cleanup before reporting a timed-out request.
5. Add focused tests for mode and queue behavior, run typechecks and targeted tests, and update the existing PR.

## Verification

- A saved Jev credential activates the new path without restart; removing it restores the old path.
- New mode cannot execute a direct legacy action after Jev abstains or fails.
- Aborted queued actions never execute and return promptly.
- A timed-out helper cannot block the next request indefinitely.
- No API key appears in status responses, logs, or tool output.

## Results on 2026-09-25

- Read-only Windows observation: 2,288 ms cold helper startup, then 294 ms and 167 ms warm observations with accessibility enabled. The observed warm path cannot explain a ten-minute pause.
- Source inspection found a ten-minute computer permission approval timeout and two serial queues that ignored cancellation while waiting. Computer approval now expires after 60 seconds, queued calls cancel promptly, and helper requests have action-specific deadlines.
- The old element click path now checks the target identity and bounding box at the coordinate before input. The Windows UI Automation scan has a 2.5-second traversal budget.
- The already cached, pinned OmniParser weight is found automatically on this machine; no repository weight or API secret is committed.
- Backend and app TypeScript checks, computer unit tests, lint, architecture validation, and generated-SDK verification pass. The Windows Vitest runner stalls before executing TSX tests, including an unchanged settings test; the new Jev settings interaction test remains in the suite for CI.
