# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **A runtime-first Multi-Agent coding system for long, parallel, recoverable engineering work.**
>
> One goal becomes a persistent workflow: **plan → parallel execution → review → reject/retry → explicit merge**.

<p align="center">
  <img src="./logo/screenshot.png" alt="JYY-Code desktop multi-agent mode: plan panel and collaboration blackboard on the right" width="900" />
</p>

<p align="center">
  <sub>The desktop app in multi-agent mode: the root agent reviews child reports one by one while the plan panel tracks step progress and the blackboard collects findings and handoffs from every sub-agent.</sub>
</p>

**Desktop install:** https://github.com/Reon-Jin/JYY-Code/releases

## Why JYY-Code is different

JYY-Code does not assume an LLM will reliably remember the plan, coordinate peers, enforce quality, isolate concurrent edits, or recover itself after a crash. Those responsibilities are moved into the **runtime**.

| Problem              | JYY-Code moves it out of the prompt and into...                                          |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Planning             | A revisioned Plan with staged Steps, explicit dependencies and judgeable `done_criteria` |
| Execution            | A strict Task state machine and protocol-enforced dispatch                               |
| Parallelism          | Batched waves of isolated sub-agents, up to 20 per wave                                  |
| Quality control      | Report → review → reject/redispatch as a mandatory gate                                  |
| Integration          | Worktree/snapshot isolation plus explicit `Merge.apply`                                  |
| Coordination         | A typed shared blackboard with read cursors and event wakeups                            |
| Route selection      | Candidate competition with blind proposals, cross-review and final synthesis             |
| Long-task continuity | Layered context, episodic digests and structured persistent memory                       |
| Crash recovery       | Durable events, rebuildable projections, activation leases and reconciliation            |

The result is not “one agent with more tools”. It is an **engineering runtime that gives agents boundaries, shared state, recovery semantics and a reviewable execution protocol**.

## 1. Protocol-enforced engineering loop

The core workflow is enforced by tools and state transitions, not by asking agents to cooperate in natural language.

```text
Plan_create → Plan_update(add_task) → Dispatch_dispatch → Report → review_task(approve) → Merge.apply → merged → cleanup
     ↑                                                              ↓
     └──────────── reject + concrete feedback → redispatch ──────────┘
```

- **Plans evolve with understanding.** Work is organized into Steps. Each Step has observable `done_criteria`; later Steps expand only after the current one is reviewed.
- **Task state is not conversational.** A Task moves through a controlled lifecycle such as `pending → dispatched → running → reported → approved / rejected / dismissed`; illegal transitions are rejected by the runtime.
- **Review is a gate, not a suggestion.** The root agent must check the report and relevant artifacts against `done_criteria`. Rejection requires a concrete gap, and that feedback is automatically injected into the next dispatch.
- **Children cannot rewrite orchestration state.** Standard child sessions report results; they do not mutate the parent Plan.
- **Exceptions are durable work items.** Failed pre-checks, cancelled children and runtime failures enter the Inbox instead of disappearing inside model text.

This turns “agent collaboration” from a prompt convention into a stateful protocol.

## 2. Parallelism without workspace chaos

JYY-Code is designed to parallelize real engineering work without letting concurrent agents overwrite one another.

- **Protocol-level parallelization.** Ready Tasks in the same wave are batch-dispatched instead of being slowly trickled out one by one. A wave can run **up to 20 sub-agents in parallel**.
- **Forced decomposition check.** For medium and large tasks, the planner must inspect independent deliverables, modules, research questions, verification surfaces and role expertise before accepting a mostly-serial plan.
- **Isolated execution.** Git projects use isolated Worktrees for standard Tasks; non-Git projects use writable snapshot workspaces. Shared-main-workspace execution is an explicit compatibility mode, not the default.
- **Review does not imply integration.** An approved child result still does not silently rewrite the parent workspace. The root agent explicitly integrates it through `Merge.apply`.
- **Conflicts remain decisions.** Non-overlapping changes can merge automatically; real conflicts are surfaced for explicit resolution instead of applying a hidden “prefer child” policy.
- **Zero polling while children run.** The root suspends after dispatch and wakes on Report, Inbox or blackboard events, avoiding token-burning wait loops.

Parallel execution, isolation, review and merge are one continuous protocol rather than separate best-effort behaviors.

## 3. A durable runtime, not a fragile process

Long-running agent systems fail when process memory is treated as the source of truth. JYY-Code separates **durable state** from **live process activity**.

- **EventV2 is the durable session source of truth.** Session changes are written to a versioned event log; projections are derived, versioned views that can be rebuilt by replay.
- **A child session is a durable identity.** A running process is only the current activation of that child. Ownership is guarded by `owner_id + generation + lease`, so a stale process cannot continue settling or mutating a child after takeover.
- **Restart recovery is explicit.** On cold start, the runtime distinguishes persisted rows from actually live workers, reconciles child state, resumes what is safe, and turns unrecoverable work into visible rejection/Inbox state.
- **Runtime streams are not mistaken for persistence.** In-memory subscriptions and notifications can disappear; durable events remain the recovery boundary.
- **Recovery paths are designed for replay and audit.** Projection watermarks, bounded recovery metadata and copy-first/resumable storage operations make corruption and migration failures inspectable instead of silent.

This matters most on the tasks where coding agents usually become least reliable: long sessions, many children, crashes, restarts and partial failures.

## 4. Shared blackboard: agents can actually coordinate

Parallel agents are not isolated chat windows. Each Step has a shared blackboard used by the user, root agent and sub-agents.

- Typed messages: `info / risk / blocker / decision / help`
- @mentions, attachments, threaded replies and Task links
- Independent read cursors and live unread state for every participant
- Event-driven wakeups when another agent posts something relevant
- Protocol rules against heartbeat/progress spam: the board is for findings, dependencies, handoffs and requests for help

The root can see child-to-child discussion, intervene directly, and keep coordination outside private prompt histories.

## 5. Candidate mode: compete before committing

When the correct route is genuinely uncertain, JYY-Code can run a controlled competition instead of letting the root agent make an early guess.

1. **Blind declaration** — 2–3 candidates independently state their approach, assumptions, risks and differentiator.
2. **Cross-review** — candidates critique each other through the blackboard before execution.
3. **Independent proposal** — each candidate develops its route in isolation.
4. **Synthesis and verdict** — the root produces a synthesis artifact, chooses exactly one winner and records the rationale plus useful contributions from runners-up.

Candidate mode turns architectural uncertainty into an auditable search process rather than a hidden chain of guesses.

## 6. Context and memory built for long tasks

JYY-Code separates short-term working context from durable knowledge instead of treating the entire chat transcript as memory.

- **Working context stays bounded.** Full compaction, micro-compaction of completed tool output, reactive emergency compaction and media-aware context estimation prevent long tool-heavy runs from expanding without control.
- **Older turns become episodic memory.** Completed turns are recorded and periodically condensed into cumulative digests that can be re-injected or searched later.
- **Persistent memory is structured by purpose.** Task state, stable user facts and reusable experience are stored separately rather than mixed into one free-form summary.
- **Memory is calibrated before and after execution.** The user-input phase updates what the system currently understands; the assistant-completion phase corrects that state with what actually happened and extracts reusable lessons.
- **Persistent writes are controlled.** Root sessions own task/user memory writes; child agents can read relevant context and experience without racing to rewrite shared long-term memory.
- **Capacity is a system property.** Entries have schema, importance, keywords, deduplication and deterministic compaction instead of unbounded “remember everything” accumulation.

The objective is not maximum history retention. It is **stable reasoning state across long sessions and new sessions without letting old noise dominate the prompt**.

## 7. Capability boundaries instead of blind trust

JYY-Code deliberately limits what different actors can mutate.

- Child agents cannot rewrite the parent Plan.
- Task output paths are constrained to the intended workspace and checked against traversal/escape cases.
- Standard child work is isolated until an explicit merge.
- Sub-agent tool access is governed independently from the root agent.
- Durable session state is owned by the privileged runtime; external extensions may consume documented events but cannot append to the durable event log or directly mutate projection tables.

These boundaries reduce the blast radius of a bad sub-agent decision and make orchestration state harder to corrupt accidentally.

## Quick Start

### Install

End users only need Node.js 20+ and npm; Bun is required only for source development.

```bash
npm install -g jyycode-ai
cd /path/to/your/project
jyy
```

Inside JYY-Code, run `/connect` to configure a model provider.

`jyy` and `jyycode` are the same CLI. The terminal directory you launch from becomes the agent workspace.

### Configuration

Global config: `~/.config/jyycode/jyycode.jsonc`

```jsonc
{
  "$schema": "https://jyycode.ai/config.json",
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "sk-...",
      },
    },
  },
}
```

Project config lives at `.jyycode/jyycode.jsonc`. Core extension points include `provider`, `permission`, `subagents`, `mcp`, `skills` and `plugin`.

## Architecture at a glance

```text
packages/jyycode/    Agent runtime, plans, sessions, memory, tools and TUI
packages/core/       Filesystem, providers and shared runtime utilities
packages/llm/        LLM protocol and runtime adapters
packages/plugin/     Plugin SDK and extension interfaces
packages/sdk/        HTTP/OpenAPI client SDK
packages/app/        Desktop web UI
packages/desktop/    Tauri desktop shell and sidecar packaging
packages/relay/      End-to-end-encrypted mobile relay
packages/mobile-web/ Mobile web / PWA client
.jyycode/            Project agents, skills, commands, themes and config
```

Foundation: Bun + TypeScript, Effect-based services, Drizzle ORM + SQLite (WAL), Turbo monorepo and oxlint.

Useful architecture references:

- [Session EventV2 source of truth](docs/architecture/session-event-source.md)
- [Process runtime](docs/architecture/process-runtime.md)
- [Session storage operations](docs/operations/session-storage.md)
- [Plan workspace operations](docs/operations/plan-workspaces.md)
- [Testing and replay](docs/architecture/testing-and-replay.md)

## Develop from Source

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

For source validation:

```bash
bun run check:ci && bun run verify:generated
```

## Downloads

Windows installers, checksums and update manifests are published on the [GitHub Releases page](https://github.com/Reon-Jin/JYY-Code/releases).

## Privacy

JYY-Code stores application data locally and connects only to services you explicitly configure or invoke. See the [privacy policy](PRIVACY.md).

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
