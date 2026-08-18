# Contributing to JYY-Code

Thanks for your interest in contributing! JYY-Code is a runtime-first multi-agent coding
system built with Bun + TypeScript, Effect, Drizzle ORM + SQLite, and a Turbo monorepo.

This guide covers how to set up the repository, what conventions the codebase follows,
and how to get your changes merged. Please read it before opening a PR.

- [Code of Conduct](#code-of-conduct)
- [Prerequisites](#prerequisites)
- [Repository setup](#repository-setup)
- [Repository layout](#repository-layout)
- [Development workflow](#development-workflow)
- [Code conventions](#code-conventions)
- [Testing](#testing)
- [Quality gates](#quality-gates)
- [Commit conventions](#commit-conventions)
- [Branching and pull requests](#branching-and-pull-requests)
- [Documentation](#documentation)
- [Security and privacy](#security-and-privacy)
- [Releases](#releases)

## Code of Conduct

Be respectful and constructive. This project is maintained by volunteers; disagreement
about code is fine, personal attacks are not. If you see unacceptable behavior, please
report it to the maintainers.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Bun](https://bun.sh/) | `1.3.14+` (see `packageManager` in `package.json`) | Required for all development |
| [Rust](https://www.rust-lang.org/) | stable toolchain | Only needed for `packages/process-guardian` and `packages/desktop` (Tauri) |
| Node.js | `20+` | Only end users need this to `npm install -g jyycode-ai`; source development uses Bun |

## Repository setup

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
```

Installations are pinned exactly (`bunfig.toml` sets `exact = true`) and are gated by a
minimum release age, so the lockfile is the source of truth. Commit `bun.lock` changes
when you add or update dependencies.

## Repository layout

This is a Turbo + Bun workspaces monorepo:

```text
packages/jyycode/    Agent runtime, plans, sessions, memory, tools and TUI (the main product)
packages/core/       Filesystem, providers and shared runtime utilities
packages/llm/        LLM protocol and runtime adapters
packages/plugin/     Plugin SDK and extension interfaces
packages/sdk/        HTTP/OpenAPI client SDK (js + openapi.json)
packages/app/        Desktop web UI (SolidJS + Vite)
packages/desktop/    Tauri desktop shell and sidecar packaging
packages/relay/      End-to-end-encrypted mobile relay
packages/mobile-web/ Mobile web / PWA client
packages/process-guardian/ Rust process supervisor
docs/architecture/   Architecture decisions and ownership contracts
docs/operations/     Operational runbooks (storage, workspaces, ...)
docs/plans/          Design plans for larger changes
.jyycode/            Project agents, skills, commands, themes and config
```

Architecture references worth reading before touching the runtime:

- [Session EventV2 source of truth](docs/architecture/session-event-source.md)
- [Process runtime](docs/architecture/process-runtime.md)
- [Testing and replay](docs/architecture/testing-and-replay.md)
- [Session storage operations](docs/operations/session-storage.md)
- [Plan workspace operations](docs/operations/plan-workspaces.md)

## Development workflow

### The agent runtime / TUI

```bash
bun run dev                      # from the repo root
# or
bun run --cwd packages/jyycode dev
```

The TUI is an interactive foreground program. When you need to inspect it from a script
or agent context, run it in `tmux` instead:

```bash
tmux new-session -d -s jyycode-dev 'bun run --cwd packages/jyycode dev'
tmux capture-pane -pt jyycode-dev
tmux kill-session -t jyycode-dev
```

### Desktop web UI

```bash
bun run --cwd packages/app dev   # Vite dev server on 127.0.0.1
bun run --cwd packages/app build
```

### Desktop (Tauri) shell

```bash
bun run --cwd packages/desktop dev
```

Requires a Rust toolchain. See `packages/desktop/README.md` for platform notes.

## Code conventions

### Language and formatting

- TypeScript, strict mode, ESM everywhere (`"type": "module"`).
- Prettier with `semi: false` and `printWidth: 120` (see `prettier` in `package.json`).
- `.editorconfig`: UTF-8, LF line endings, 2-space indentation.
- Linting is done with **oxlint** (`bun run lint`). Do not disable rules to silence
  warnings without a code comment explaining why.

Format your changes before committing:

```bash
bun run script/format.ts
```

### Module shape

- Do **not** use `export namespace Foo { ... }`. Use flat top-level exports plus a
  self-reexport at the bottom of the file, and import the namespace projection:

  ```ts
  export * as Foo from "./foo"
  // consumers: import { Foo } from "@/foo/foo"
  ```

- In multi-sibling directories (e.g. `src/session/`), keep each sibling in its own file
  with its own self-reexport and **do not add a barrel `index.ts`** — barrels defeat
  tree-shaking and slow module load.

### Effect

The runtime is built on Effect. See `packages/jyycode/AGENTS.md` and
`packages/jyycode/specs/effect/migration.md` for the full pattern reference. Key rules:

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` / `Effect.fnUntraced` for named/traced effects; avoid
  unnecessary outer `.pipe()` wrappers.
- Use `Schema.Class` for multi-field data, `Schema.brand` for single-value types,
  `Schema.TaggedErrorClass` for typed errors.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`.

### Database (Drizzle ORM + SQLite)

- Schema lives in `src/**/*.sql.ts` inside `packages/jyycode`.
- Tables and columns use `snake_case`; join columns are `<entity>_id`; indexes are
  `<table>_<column>_idx`.
- Generate migrations with Drizzle Kit:

  ```bash
  bun run --cwd packages/jyycode db generate --name <slug>
  ```

- Never edit existing migrations; always add a new one. Database rollback rules are in
  [RELEASE.md](RELEASE.md).

### Architecture boundaries

`bun run verify:architecture` enforces package dependency boundaries. Cross-package
imports that violate the boundaries fail CI. File-level exceptions exist only for
permanent platform/compatibility adapters (see `script/verify-architecture.ts`); do not
add directory-wide exemptions.

## Testing

Each package runs its own tests with Bun's test runner. From the root:

```bash
bun run test:ci          # runs every workspace's test:ci
bun run --cwd packages/jyycode test        # single package
bun run --cwd packages/jyycode test:file   # interactive single-file runner
```

Runtime correctness is validated across four complementary layers
(see [Testing and replay](docs/architecture/testing-and-replay.md)):

| Layer | What it covers |
| --- | --- |
| Unit / contract | Pure schemas, normalization, process and credential contracts |
| Protocol cassette | Provider protocol and transport behavior (recorded replay) |
| Product replay | Deterministic local fixtures exercising the real session loop, event writes and projections |
| Built smoke | Built CLI and HTTP server entry points (`test:built-smoke`) |

Important rules:

- **Replay fixtures** record model replies, request envelopes, durable events and
  projected output. Update them with `UPDATE_REPLAY=1` locally when behavior changes
  intentionally; **never** leave update mode enabled — CI fails if it is.
- **Fixtures must be value-free.** Authorization headers, cookies, API keys and the full
  user home directory are redacted or rejected. Never add a fixture containing secrets.
- **Stress gates** (`test:stress`) and **runtime budgets** (`check:runtime-budget`) run
  in CI. Run them locally before opening a PR if your change touches scheduling,
  memory, or the session loop.

## Quality gates

CI runs the same checks locally via:

```bash
bun run check:ci
```

This runs, in order: `lint` → `typecheck` → `verify:architecture` →
`verify:generated` → `test:ci`. The `verify:generated` step checks the event catalog and
the generated SDK are up to date. If your change touches events, SDK surfaces, or the
TUI help text, run it first:

```bash
bun run verify:generated
```

Make sure everything passes before pushing:

```bash
bun run lint
bun run typecheck
bun run verify:architecture
bun run verify:generated
bun run test:ci
```

## Commit conventions

The repository uses [Conventional Commits](https://www.conventionalcommits.org/). A
commit message looks like:

```text
feat(tui): add file tree with preview and search
fix(session): bound tool_search by generic execution budget
docs: update desktop feature parity table
test(cli): update help-text snapshots
```

- **Type**: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`, ...
- **Scope** (optional): the affected area, e.g. `tui`, `session`, `cli`, `ci`,
  `design-tokens`, `plugin`.
- Keep the subject short and imperative; explain *why* in the body when it isn't obvious.

## Branching and pull requests

1. Open an issue first for anything non-trivial, and reference it in your PR
   (`Closes #123`).
2. Create a branch off `main` with a descriptive name, e.g. `fix/session-timeout-leak`.
3. Make focused commits. **Keep unrelated changes out of the PR** — a reviewer will
   reject a PR that mixes refactors with a bug fix.
4. Run the quality gates above before pushing.
5. Open a PR and fill in [the PR template](.github/pull_request_template.md): link the
   issue, describe the change and why it works, and explain how you verified it. For UI
   changes, include a screenshot or recording.

Guidelines:

- If you don't understand why your change works, say so — a maintainer needs to know how
  much to trust the PR.
- **Do not** paste large AI-generated descriptions into the PR body. The template
  explicitly warns that such PRs may be ignored or closed.
- Small, well-scoped PRs are merged faster than large ones. Split big features into
  reviewable steps.
- Maintainers may ask for changes; treat review feedback as a collaboration, not an
  obstacle.

## Documentation

- User-facing changes should update [README.md](README.md) and its Chinese mirror
  [README-zh.md](README-zh.md).
- Architectural or operational changes should update the relevant file under
  `docs/architecture/` or `docs/operations/`, or add a plan under `docs/plans/` for
  large changes.
- Keep the docs consistent with the code in the same PR.

## Security and privacy

- Never commit secrets, API keys, tokens, cookies, or personal data. This applies to
  code, tests, **fixtures**, and documentation.
- User data is stored locally; see [PRIVACY.md](PRIVACY.md) for the product's privacy
  model and [docs/architecture/credentials.md](docs/architecture/credentials.md) for how
  credentials are handled.
- Changes to signing or release infrastructure must respect
  [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
- If you believe you found a security issue, report it privately to the maintainers
  rather than opening a public issue.

## Releases

Releases are driven by maintainers through the `release-cli-npm`,
`desktop-release` and `desktop-windows` workflows. See [RELEASE.md](RELEASE.md) for the
full process, including database backup, migration, and integrity-check requirements.
Contributors do not need to bump versions — versioning happens at release time.
