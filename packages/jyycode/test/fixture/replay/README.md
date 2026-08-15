# Product replay fixtures

Replay fixtures are value-free, single-file JSON snapshots for product-level
session behavior. Each fixture contains:

- `version` and a deterministic `workspaceSeed`;
- `sessionInput` and ordered `modelReplies`;
- `expected.requestEnvelopes`, `expected.messages`, `expected.events`, and
  `expected.files`;
- the final `terminalStatus`.

The runner must enter through `SessionPrompt.Service`, use the existing test
LLM server and temporary-instance helpers, and observe the durable events and
projected messages after the operation. It must not duplicate the session loop
or call a private projector as a shortcut.

Paths, generated IDs, timestamps, ports, process IDs, and optional token/cost
or timing values are normalized by semantic field in `test/lib/replay/normalize.ts`.
Authorization, cookies, API keys, and full home-directory paths are rejected.

Run stable fixtures with `bun run test:replay`. To intentionally update a
fixture locally, set `UPDATE_REPLAY=1`; CI rejects update mode.
