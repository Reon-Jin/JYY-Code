# Runtime kernel boundaries

This document is the canonical boundary decision for the runtime quality
migration. It applies to product code and is intentionally stricter than the
set of currently migrated modules.

## Ownership matrix

| Area | Privileged kernel ownership | Controlled extension point |
| --- | --- | --- |
| Session and agent loop | `packages/jyycode/src/session` | LLM and tool ports |
| Plan, dispatch, review, merge | `packages/jyycode/src/plan` | Project-level tools |
| Permissions and event persistence | `packages/jyycode/src/sync` and session services | None |
| Process execution and supervision | `packages/core/src/process*` | Declarative process specs |
| Credential references and resolution | Core credential contract and product auth adapter | Provider-specific auth route |
| Model providers | Runtime port and request preparation | Provider adapters |
| MCP, skills, and project tools | Permission-gated tool port | Tool implementations |

The kernel owns the session processor, agent loop, plan lifecycle, permission
checks, event store, process supervision, and credential boundary. Plugins may
implement a controlled adapter, but they cannot replace or obtain the kernel
services through a plugin registry.

## Dependency direction

```text
App / CLI / SDK
      |
HTTP API / product commands
      |
Privileged product kernel
  |       |        |       |
session  plan   events  process / credentials
  |       |        |       |
LLM port  tool port  projections  platform adapters
  |       |
provider adapters  MCP / skills / project tools
```

`packages/core` is reusable and must not import `packages/jyycode`. The LLM
protocol package must not import product session code. Native process APIs are
limited to explicit platform adapters until the AppProcess migration is
complete. The verifier reports each temporary exception by file and migration
task; it does not allow an entire directory.

## Non-adopted structure

This repository does not adopt Cordis, a global dynamic service container, a
plugin-replaceable session processor, or a large matrix of micro-packages.
Effect services and layers are used for explicit static assembly of runtime
dependencies. Provider, MCP, skills, and project tools remain ports with
permission and event boundaries around them.
