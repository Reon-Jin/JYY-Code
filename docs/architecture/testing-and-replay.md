# Testing and replay layers

Runtime correctness is checked through four complementary layers. A lower
layer may isolate a contract, but product behavior must also be exercised from
the real product entry point.

| Layer | Responsibility | Network policy |
| --- | --- | --- |
| Unit / contract | Pure schemas, normalization, process and credential contracts | No network |
| Protocol cassette | Provider protocol and transport behavior | Recorded replay by default |
| Product replay | `SessionPrompt`, request preparation, tool execution, event write, projection, and API-visible result | Deterministic local fixtures |
| Built smoke | Built CLI and HTTP server entry points, health and a text turn | Local only |

Product replay fixtures record the workspace seed, session input, ordered model
replies, model-visible request envelopes, durable events, projected messages,
expected files, and terminal status. Paths, IDs, timestamps, ports, process IDs,
and optional timing/token fields are normalized by semantic field rather than
by blind string replacement.

Fixture updates require `UPDATE_REPLAY=1` locally. CI fails if update mode is
enabled. Fixtures must be value-free: authorization headers, cookies, API keys,
and the full user home directory are redacted or rejected before persistence.

The product replay runner composes existing test server, LLM server, database,
and session services. It must not copy the session loop or call a private
projector as a shortcut. Each scenario asserts three observations: what the
next model call actually received, the event fact written to storage, and the
message/API projection visible to the user.

## Runtime stress and fault gates

The deterministic stress suite lives in `packages/jyycode/test/stress` and uses
the same local fixtures as the PR tests. The default PR profile runs 500 replay
events, 20 concurrent process cancellations, and 4 child activations. The
nightly profile runs 5,000 and 50,000 replay events, 100 process cancellations,
and 20 child activations on both Linux and Windows.

Run the PR gate with:

```powershell
bun run test:stress
bun run check:runtime-budget
```

Each run writes timing, peak RSS, remaining-pid, and recovery diagnostics under
`packages/jyycode/.artifacts/runtime-budget`. The tracked
`runtime-budget.baseline.json` contains measured PR and nightly baselines;
`check-runtime-budget.ts` permits 2× noise but rejects missing resources and
order-of-magnitude regressions. Updating a baseline requires
`UPDATE_BUDGET=1` locally and is rejected in CI.

Fault gates assert an explainable terminal state rather than only checking that
an exception occurred: a reset blob stream is retryable, a stubborn process is
`kill_failed`, a lost child owner is recovered and settled, and an interrupted
merge flush leaves the parent `recovery_required` without deleting child
workspaces.
