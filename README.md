# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **A Multi-Agent engineering workflow that plans, delegates, reviews, revises, and delivers.**
>
> Turn one prompt into a persistent, observable engineering run.

<p align="center">
  <img src="./logo/screenshot.png" alt="JYY-Code desktop multi-agent mode: plan panel and collaboration blackboard on the right" width="900" />
</p>

<p align="center">
  <sub>The desktop app in multi-agent mode: the root agent reviews child reports one by one while the plan panel tracks step progress and the blackboard collects findings and handoffs from every sub-agent.</sub>
</p>

**TUI install:** `npm install -g jyycode-ai` · **Launch:** `jyy`

**Desktop install:** https://github.com/Reon-Jin/JYY-Code/releases

## Why JYY-Code

Most AI coding tools are "one chat box + one agent": you watch it work step by step, restart from scratch when it goes wrong, and lose context, accountability, and momentum as soon as the task gets large.

JYY-Code upgrades a single request into **an organized engineering run**:

- **Enforced by protocol, not by goodwill.** Planning, dispatch, reporting, and review are all enforced by a runtime protocol — child agents can only report; they cannot rewrite the plan. A rejection must state the exact gap, and the feedback is automatically carried into the next dispatch.
- **Backed by state, not by memory.** Plans persist as revisioned structured files with optimistic-concurrency writes; sessions, snapshots, and the blackboard all live in SQLite (WAL), so runs resume precisely after restarts or channel switches.
- **Powered by a team, not a lone agent.** One root agent orchestrates up to 20 parallel sub-agents with distinct roles and models, coordinating over a shared blackboard — with structured human-in-the-loop questions at decision points.

You hand over a one-line goal; you get back reviewed, auditable engineering output.

## Core Highlights

### A Closed-Loop Multi-Agent Engineering Workflow

The core of JYY-Code is an engineering loop enforced by the runtime — not a prompt that asks agents to "please cooperate":

```text
Plan_create → Plan_update(add_task) → Dispatch_dispatch → Report → review_task
     ↑                                                              ↓
     └────── reject + concrete feedback (auto-injected next time) ──┘
```

- **Staged plans**: work is decomposed into Steps, each with observable, judgeable `done_criteria` (e.g. "file X exists and contains Y") — vague criteria like "done properly" are rejected. Only when the current Step passes review does the next Step expand into tasks: the plan evolves with understanding instead of being frozen up front.
- **State-machine task lifecycle**: every Task moves strictly through `pending → dispatched → running → reported → approved / rejected / dismissed`; illegal transitions are refused by the protocol itself.
- **Review as a gate**: the root agent checks each report against `done_criteria` and spot-checks artifacts before ruling. A `reject` must state which criterion failed and how; on redispatch the tool automatically injects `previous_feedback` into the child's brief — failures are never silently swallowed.
- **Permission isolation**: child sessions can only `Report` and can never touch the parent plan. Every Task binds to its own `output_path`, and paths escaping the workspace are rejected at dispatch time.
- **Exception Inbox**: failed report pre-checks, cancelled children, and runtime errors all land in an Inbox with suggested actions; the root agent must clear exceptions before moving on.
- **Optimistic concurrency & recovery**: plan writes are revision-checked and conflicts return the latest state for re-decision; plan files, snapshots, and events are all persisted, so a crashed run resumes where it stopped.

### Extreme Parallelism

JYY-Code writes "parallelize everything parallelizable" into the protocol instead of leaving it to model discretion:

- **Batch dispatch**: all ready Tasks in a wave must go into a single `Dispatch_dispatch` — **up to 20 parallel sub-agents per wave**, no splitting, no serial trickling.
- **Parallelizability check**: before decomposing a medium/large task, the protocol requires enumerating every split dimension — independent deliverables, independent modules, independent research questions, independent verification surfaces, independent role expertise — targeting 4–8 non-blocking Tasks per wave by default; waves under 4 Tasks must justify each dimension that fails.
- **Role-based waves**: Tasks for different roles dispatch in separate waves, while same-role Tasks merge into one wave for maximum scheduling efficiency.
- **Worktree isolation**: built-in Git worktree management keeps parallel experiments from polluting each other's workspace.
- **Event-driven, zero polling**: after dispatch the root agent suspends immediately and wakes precisely on Report / Inbox / blackboard events — not a single token wasted on waiting.

### Multi-Candidate Competition

For undecided route choices — technology selection, architecture, copy style — the root agent doesn't just pick one. JYY-Code starts **candidate mode**: a controlled competition:

1. **Blind declaration**: 2–3 candidate agents each submit `approach / assumptions / risks / differentiator`, independently.
2. **Cross review**: candidates reply directly to every peer's declaration on the blackboard; all mutual reviews must complete before anyone is ready.
3. **Independent execution**: in the running phase, candidates implement their proposals in a sandbox (shell, edit, MCP and similar tools disabled), each producing an isolated proposal.
4. **Synthesis & verdict**: the root agent generates a synthesis artifact from all proposals, atomically selects exactly one winner, and records contributing runners-up plus the rationale — capturing the upside of competition with a full decision audit trail.

### Rich Built-In Roles

A well-staffed team out of the box; each role carries its own **model, thinking depth, tool whitelist, and dedicated skills**:

| Role | Specialty | Bundled skills |
| --- | --- | --- |
| **Planner** | Deep trade-off analysis, high-quality implementation plans | writing-plans |
| **Frontend Engineer** | Polished UI / frontend implementation | design, ui-ux-pro-max, efficiency, executing-plans |
| **Backend Engineer** | Rigorous, reliable backend code | efficiency, executing-plans |
| **Researcher** | Broad web investigation and synthesis | agent-reach (fine-grained search across major platforms), firecrawl MCP |
| **Office Master** | Word / PowerPoint / Excel / PDF generation and processing | docx, pptx, xlsx, pdf |
| **Charter** | All kinds of charts (garbled-free CJK rendering) | chart, graph, chart-visualization, antv-s2-expert |
| **General** | General-purpose delegated execution | — |

Roles are configuration, not a black box: edit, disable, delete, or add roles freely — changes persist to the global config, and project-level `.jyycode/agent/` holds team-specific agent definitions.

### Shared Blackboard

Parallel agents are not islands. JYY-Code provides a Step-scoped shared blackboard as the team's coordination hub:

- **Typed messages**: five semantic kinds — `info / risk / blocker / decision / help` — with @mentions, attachments, threaded replies, and task linking.
- **Read cursors**: every participant keeps an independent read position; unread counts are live, and wakeups mean immediate handling.
- **Humans on the same board**: the user, root agent, and sub-agents collaborate on one surface; the root can read child-to-child conversations and step in directly.
- **Anti-noise discipline**: the protocol explicitly forbids heartbeats and repeated progress spam — the board carries only findings, dependencies, handoffs, and help requests.
- Candidate-mode blind declarations and cross reviews run on the same blackboard: one mechanism, unified semantics.

### Structured Memory, Calibrated Before and After Execution

JYY-Code's memory is not "chat history archiving" — it is a schema-governed, capacity-disciplined layered store:

- **Separated scopes**: `MEMORY.json` holds one bounded task-state entry per session, `USER.json` holds stable user facts, and `EXPERIENCE.json` holds reusable success/failure/lesson rules. Task and user scopes are isolated from cross-project experience.
- **Two-phase calibration**: the same memory entry is updated once during the **user-input phase** ("the user asked for A") and again during the **assistant-completion phase** ("I used B, and ultimately learned C") — understanding is calibrated before execution, experience is deposited after it. No "written then forgotten", no stale errors left uncorrected.
- **Structured entries**: every entry carries an importance score (1–10) and normalized keywords with automatic dedup; writes follow strict character budgets — no rambling logs.
- **Auto-injected every request**: a top-memory snapshot rides in every system prompt, so a brand-new session starts with the team's accumulated knowledge.
- **Self-managing capacity**: approaching a cap triggers deterministic compaction and retention; sub-agent sessions can read context and experience, but persistent task/user memory remains root-only and write-protected.
- An explicit memory management tool (add / replace / remove / compact) is available whenever the user wants to intervene.

## Quick Start

### Install

End users only need Node.js 20+ and npm; Bun is required only for source development.

```bash
npm install -g jyycode-ai
cd /path/to/your/project
jyy
```

Inside JYY-Code, run `/connect` to configure a model provider.

`jyy` and `jyycode` are the same CLI. The terminal directory you launch from becomes the agent's workspace.

### Configuration file

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

Project config lives at `.jyycode/jyycode.jsonc`. Main keys: `provider`, `permission`, `subagents`, `mcp`, `skills`, and `plugin`. Context compaction is configured with `compaction.auto`, `compaction.trigger_ratio` (default `0.92`), `compaction.micro_compact`, `compaction.micro_compact_max_chars`, and `compaction.reactive_compact`; the micro and reactive stages are active in the request pipeline and expose bounded stage statistics to telemetry.

## More Built-In Capabilities

- **Layered context engineering**: full compaction, micro-compaction of completed tool output, reactive emergency compaction, and overflow recovery pipelines with media-aware context estimation — long runs retain a bounded, inspectable working context.
- **Git-grade snapshots & revert**: every turn's file changes land in a shadow Git snapshot; revert / unrevert at message granularity with per-file diffs; sessions can fork and generate share links.
- **Human-in-the-loop questions**: when execution hits ambiguity, the agent asks you structured multiple-choice questions mid-run (with recommended options and multi-select), keeping decisions on track.
- **Permission system**: per-tool allow / ask / deny rules, plus an independent tool policy and fixed toolset for sub-agents.
- **Open extensibility**: MCP servers, provider plugins (Codex, GitHub Copilot, xAI, Azure, Cloudflare, and more), LSP diagnostics, ACP protocol adapter, project-level custom commands and custom tools (`.jyycode/tool/*.ts`), and swappable themes.
- **Multilingual glossaries**: built-in translation glossaries for 16 languages keep terminology consistent across multilingual deliverables.
- **Every surface covered**: terminal TUI (OpenTUI + Solid), a Tauri 2 desktop app, iOS and mobile web clients (paired through an end-to-end-encrypted relay that never sees task plaintext), plus a full HTTP server, OpenAPI spec, and JS SDK for embedding into any automation system.

## Session Safety & Recovery

JYY-Code isolates the databases of released builds and source-development builds. Run:

```bash
jyycode db status
```

to inspect the current database, release channel, migration status, and session counts without touching any other database. Before changing channel policy, stop JYY-Code and back up the database together with its `-wal` and `-shm` files.

If sessions appear "lost", first confirm the current database with `jyycode db status`, then open `/sessions` from the same project or worktree.

Session-storage migrations are copy-first and resumable. Use `jyycode storage backfill --dry-run --json` before applying a bounded backfill; it records a timestamp watermark and cursor so interrupted runs can resume. Keep the database and blob root as a matched pair, retain the original copy for rollback, and defer payload pruning and blob garbage collection until recovery checks pass. The disposable-root soak command is documented in [session-storage operations](docs/operations/session-storage.md).

Plan workspace cleanup is also inventory-first. Run `jyycode debug plan-workspaces inspect --project global --json` and the matching `cleanup --dry-run` before any quarantine apply; unknown directories and `kill_failed` results require manual review. See [plan workspace operations](docs/operations/plan-workspaces.md) for the backup and quarantine boundaries.

## Develop from Source

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

```text
packages/jyycode/   Main CLI, agents, sessions, memory, tools, and TUI
packages/core/      Filesystem, providers, and shared utilities
packages/llm/       LLM protocol and runtime adapters
packages/plugin/    Plugin SDK and extension interfaces
packages/sdk/       JYY-Code API client (JS) and OpenAPI
packages/app/       Desktop web UI (Solid)
packages/desktop/   Tauri desktop shell and sidecar packaging
packages/relay/     End-to-end-encrypted mobile relay
packages/mobile-web/ Mobile web / PWA client
.jyycode/           Project agents, skills, commands, themes, and config
memory/             Structured persistent memory
```

Foundation: Bun + TypeScript throughout, an Effect-based service architecture, Drizzle ORM + SQLite (WAL), Turbo monorepo, oxlint.

## Downloads

Windows installers, checksums, and update manifests are published on the [GitHub Releases page](https://github.com/Reon-Jin/JYY-Code/releases).

## Privacy

JYY-Code stores application data locally and connects only to services you explicitly configure or invoke. See the [privacy policy](PRIVACY.md) for details.

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
