# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **A Multi-Agent engineering workflow that plans, delegates, reviews, revises, and delivers.**
>
> Turn one prompt into a persistent, observable engineering run.

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code animated logo" width="500" />
</p>

JYY-Code is a terminal-first Multi-Agent system for real software and documentation work. Instead of asking one general-purpose agent to carry the entire context and judge its own output, JYY-Code turns a goal into a managed engineering workflow: a primary agent plans the work, delegates it to specialists, reviews every result, sends rejected work back for revision, and synthesizes only accepted results into the final delivery.

```text
Plan → Delegate → Execute in parallel → Review → Revise → Synthesize
```

**Install:** `npm install -g jyycode-ai` · **Launch:** `jyy`

Press **F9** to enable the Multi-Agent workflow. Run **`/cluster`** to choose models for the planner, complex tasks, simple tasks, and visual tasks.

## Why JYY-Code

| Typical coding agent | JYY-Code |
| --- | --- |
| Forgets context between sessions | Keeps structured project and user memory |
| Hides work inside a text stream | Shows plans, tasks, agents, and status in the TUI |
| Loses background-task state | Persists sessions, cluster runs, tasks, and events in SQLite |
| One agent writes and judges its own result | Specialists produce code and documents; the primary agent reviews, rejects, and synthesizes |
| Exposes an oversized tool catalog | Finds the right tool with BM25-powered tool search |

## Highlights

### A Closed-Loop Multi-Agent Workflow

Press **F9** to enable Multi-Agent mode and turn a large request into a dependency-aware execution plan. Use **`/cluster`** to route different models to the planner, complex, simple, and visual roles, so each stage can use the model best suited to it.

- **Plan:** the cluster primary converts the goal into explicit tasks, dependencies, acceptance criteria, and expected artifacts.
- **Delegate:** researcher, coder, tester, analyst, visual, chart, PDF, and other specialists receive focused context and can run in parallel.
- **Review:** every submitted result is checked against its acceptance criteria; unfinished tasks cannot pass the completion gate.
- **Revise:** rejected work is returned to the same specialist session with concrete issues, preserving context across review rounds.
- **Synthesize:** the primary waits for terminal task states and combines only accepted outputs into one coherent code or document delivery.
- Configurable concurrency and per-role model routing balance quality, speed, and cost.
- Git worktree isolation keeps parallel coding tasks from stepping on each other.

This separation of planning, production, and quality control gives JYY-Code stronger code and document delivery than a single agent that must research, implement, verify, and self-review inside one context window.

### Structured Memory That Tracks Work Before and After Execution

JYY-Code uses transparent, schema-validated JSON memory instead of an opaque vector database:

- `MEMORY.json` stores the evolving task state and final outcome for each primary session; `USER.json` stores durable user facts and preferences.
- A semantic update runs at the start of a user step, so the active request is captured before execution, then runs again after the assistant finishes to replace it with the verified completion state.
- In Multi-Agent runs, memory ignores the intermediate planning response and learns from the final synthesis, preventing plans from being mistaken for delivered results.
- Each entry has an importance score, normalized keywords, concise content, and—for task memory—date and session provenance. The most important and relevant entries are injected into the prompt, while on-demand search ranks matches by keywords, content, and importance.
- Deterministic upserts replace entries with the same normalized keyword key instead of endlessly appending near-duplicates.
- At capacity thresholds, automatic compaction merges overlapping entries and retains information using importance, recency, and keyword reuse; hard limits prevent uncontrolled prompt growth.
- Strict schema validation, sensitive-data rejection, primary-session-only writes, file locks, atomic replacement, and an append-only audit trail protect integrity and make every mutation traceable.

The result is memory that is selective rather than noisy, inspectable rather than opaque, and safe to share across a Multi-Agent run without letting sub-agents pollute the durable record.

### Durable Runs You Can Trust

Long-running work should not disappear when a terminal refreshes.

- Sessions, messages, Todos, cluster runs, cluster tasks, and events are stored in SQLite.
- Child sessions stay bound to their plan task IDs.
- Background work remains observable through `task` and `task_status`.
- The `/sessions` dialog restores persisted root sessions.
- Release channels use isolated databases to prevent accidental schema crossover.

### A TUI Built for Agent Work

The sidebar separates three different kinds of progress:

- **Multi-Agent Plan** — goal, run status, steps, and agent counts.
- **Tasks** — queued, running, done, and failed cluster tasks.
- **Todo** — ordinary `todowrite` items without duplicating structured task state.

You can see what is happening, what is blocked, and what finished—without reading the entire transcript.

### Find the Right Tool at the Right Time

Press **F10** for intelligent tool search.

- Field-weighted BM25 ranks tool IDs, categories, parameters, descriptions, and examples.
- Exact-match and intent boosts keep specific tools above generic results.
- Progressive disclosure can keep core tools visible while loading long-tail tools on demand.
- Built-in, plugin, and MCP tools share the same catalog, permission, and telemetry path.

Core tools cover file discovery, search, atomic multi-editing, shell execution, long-running processes, sub-agent tasks, and output truncation.

## Quick Start

### Install

Requirements: Node.js 20+ and npm. Bun is only required for source development.

```bash
npm install -g jyycode-ai
cd /path/to/your/project
jyy
```

Inside JYY-Code, run `/connect` to configure a model provider.

`jyy` and `jyycode` are the same CLI. The current terminal directory becomes the agent workspace.

### Configure by File

Global config: `~/.config/jyycode/jyycode.jsonc`

```jsonc
{
  "$schema": "https://jyycode.ai/config.json",
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "sk-..."
      }
    }
  }
}
```

Project config lives in `.jyycode/jyycode.jsonc`. Main areas are `provider`, `permission`, `agent_cluster`, `mcp`, `skills`, and `plugin`.

## How It Works

```text
User request
  → Restore session + memory
  → Build system prompt (instructions + skills + memory + tools)
  → Plan and delegate work
  → Run agents and tools with permission checks
  → Persist tasks, events, messages, and results
  → Review output and gate completion
  → Evaluate durable memory after the turn
```

In cluster mode:

```text
Goal
  → Planner
  → Persisted dependency graph
  → Parallel sub-agents
  → Reviewer
  → Final synthesis
```

## More Built In

- **20+ model providers** — Anthropic, OpenAI, Gemini, Bedrock, Azure, GitHub Copilot, OpenRouter, xAI, Groq, Mistral, and more.
- **MCP and plugins** — connect external tools, hooks, and TUI extensions.
- **Skills** — load reusable domain knowledge and workflows from local or remote sources.
- **LSP integration** — give agents code intelligence beyond text search.
- **Email adapters** — SMTP, IMAP, OAuth2, and MIME attachments.
- **Context awareness** — estimate active context without counting PDF and image data URLs as raw text.
- **Session sync** — restore and synchronize work across environments.
- **Permission controls** — configure ask, allow, or deny rules by tool, agent, and session.

## Session Safety and Recovery

JYY-Code keeps packaged and source-development databases separate. Use:

```bash
jyycode db status
```

This shows the active database, release channel, migrations, and session counts without modifying other databases. Stop JYY-Code and back up the database together with its `-wal` and `-shm` files before changing channel policy.

If a session appears missing, confirm the active database with `jyycode db status`, then open `/sessions` from the same project or worktree.

## Develop From Source

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
packages/sdk/       JYY-Code API client
.jyycode/           Project agents, skills, commands, themes, and config
memory/             Structured persistent memory
```

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
