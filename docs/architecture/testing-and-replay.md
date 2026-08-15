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
