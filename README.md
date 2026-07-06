# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

[中文文档](README-zh.md) · [English](README.md)

> **Coding agents that remember, delegate, and finish.**
>
> Turn one prompt into a persistent, observable engineering run.

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code animated logo" width="500" />
</p>

JYY-Code is a terminal-first agent system for real software work. It plans complex tasks, delegates them to specialized agents, tracks every background job, remembers durable context, and resumes from persisted state instead of starting over.

```text
Plan → Delegate → Execute in parallel → Review → Resume → Ship
```

**Install:** `npm install -g jyycode-ai` · **Launch:** `jyy`

If you want coding agents to behave like an engineering team—not a scrolling chat window—JYY-Code is built for you. If that sounds useful, give the project a ⭐.

## Why JYY-Code

| Typical coding agent | JYY-Code |
| --- | --- |
| Forgets context between sessions | Keeps structured project and user memory |
| Hides work inside a text stream | Shows plans, tasks, agents, and status in the TUI |
| Loses background-task state | Persists sessions, cluster runs, tasks, and events in SQLite |
| Runs one general-purpose agent | Delegates to specialized agents with dependencies and review |
| Exposes an oversized tool catalog | Finds the right tool with BM25-powered tool search |

## Highlights

### Multi-Agent Engineering, Not Agent Theater

Press **F9** to turn a large request into a dependency-aware execution plan.

- Planner, orchestrator, specialist, and reviewer roles.
- Researcher, coder, tester, analyst, visual, chart, PDF, and other focused agents.
- Parallel background execution with configurable concurrency and model routing.
- Explicit task IDs, dependencies, acceptance criteria, and expected artifacts.
- Review rounds and completion gates prevent premature “done” responses.
- Git worktree isolation keeps parallel coding tasks from stepping on each other.

### Memory That Survives the Chat

JYY-Code uses two strict JSON stores instead of an opaque vector database:

- `MEMORY.json` keeps one evolving task memory per session.
- `USER.json` keeps stable user facts and preferences, keyed by normalized keywords.
- The first model step receives the top 10 entries from each store—20 entries maximum.
- Relevant entries are searched and injected automatically during a conversation.
- Post-turn evaluation decides whether durable results should update memory; the first valid turn has a safe fallback.
- Schema validation, sensitive-data checks, deduplication, capacity limits, file locks, and atomic replacement protect the stores.
- Only primary sessions can write. Sub-agents can read memory without corrupting it.

The result: less repeated setup, more consistent decisions, and agents that improve their understanding of your project over time.

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

## Star the Project

JYY-Code is for developers who want agents with memory, coordination, visibility, and follow-through.

If that is the direction you want coding agents to take, [star JYY-Code on GitHub](https://github.com/Reon-Jin/JYY-Code) ⭐

## License

MIT © [JYYCode](https://github.com/Reon-Jin/JYY-Code)
