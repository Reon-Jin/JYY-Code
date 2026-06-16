# JYY-Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

> AI-powered development tool with communication capabilities, built on OpenCode and inspired by Claude Code.

JYY-Code is an intelligent coding agent that combines multi-agent orchestration, persistent memory, skill learning, and communication features into a unified development assistant. It extends the OpenCode protocol with stronger workflow state, safer tool execution, and a terminal UI designed for long-running agent work.

## Features

### Multi-Agent Cluster

JYY-Code includes an orchestrator-planner-reviewer architecture that decomposes complex tasks, dispatches them to specialized sub-agents, reviews their output, and synthesizes the final result.

Highlights:

- Specialized sub-agents such as researcher, analyst, coder, tester, reviewer, chart, PDF, and visual roles.
- Configurable limits for maximum sub-agents, concurrency, review rounds, and model routing.
- Dependency-aware plans with structured task IDs, acceptance criteria, and expected artifacts.
- Background sub-agent execution through the `task` and `task_status` tools.
- Structured sub-agent return format with explicit status and summary fields.
- Completion gating so the primary agent does not treat a cluster as complete while tracked child tasks are still active.

### Persistent Agent Cluster State

Multi-agent execution state is persisted in SQLite instead of being inferred only from assistant text.

- `agent_cluster_run` stores run-level status, goal, planner model, reviewer model, and completion time.
- `agent_cluster_task` stores planned tasks, child session bindings, task status, review rounds, acceptance criteria, and artifacts.
- `agent_cluster.event` updates the TUI as run and task state changes.
- `GET /session/:sessionID/agent-cluster` exposes persisted runs and tasks for UI and integrations.
- Child task sessions are bound back to their plan task IDs, making status tracking reliable across background execution and session refreshes.

### Task-Focused TUI Sidebar

The terminal UI now separates planning, execution, and classic TodoWrite items:

- **Multi-Agent Plan** shows compact run-level progress: status, step count, agent counts, and goal preview.
- **Tasks** shows structured multi-agent tasks with queued, running, done, and failed states.
- **Todo** is reserved for normal `todowrite` items and hides when structured cluster tasks are present.

This avoids duplicate or conflicting progress signals and makes long-running multi-agent sessions easier to scan.

### Email & Communication

Built-in SMTP/IMAP adapters allow agents to send and receive email directly within sessions.

- SMTP with STARTTLS and SMTPS.
- OAuth2, including Microsoft device-code flow.
- MIME attachments with automatic content-type detection.
- IMAP mailbox polling and mail-session detection.

### Hermes-Inspired Memory System

A structured file-based memory system captures durable project facts, conventions, user preferences, and lessons learned across sessions.

- Dual-scope storage for project and user memory.
- Confidence-rated entries with source tracking.
- Automatic post-turn memory extraction.
- Search, patch, supersede, and suggest operations.

### Skill Learning

Markdown-based skills load domain knowledge, workflows, and tool integrations from local or remote sources.

- Local discovery from `.jyycode/skills/`.
- Remote skill discovery through HTTP indexes.
- Frontmatter metadata for relevance matching.
- Runtime skill loading through the skill tool.

### Intelligent Tool Search

Token-based relevance scoring helps the agent find the right tool without exposing the full catalog every turn.

- Scores tool IDs and descriptions.
- Ranks exact, substring, and content matches.
- Returns parameter summaries for fast tool selection.

### Architecture Optimizations

- **Workflow state** - SQLite-backed sessions, message parts, todos, cluster runs, cluster tasks, and event projection.
- **Worktree management** - Git worktree creation, removal, reset, and isolated sub-agent execution.
- **Tool calling normalization** - schema validation, parameter parsing, output truncation, permission gating, and metadata propagation.
- **Security constraints** - configurable ask/allow/deny permissions per tool, agent, and session.

### Additional Capabilities

- 20+ LLM providers: Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure, GitHub Copilot, OpenRouter, xAI, Groq, Mistral, and more.
- MCP support for external tool servers.
- npm and internal plugin system with hooks and TUI extension points.
- SolidJS/OpenTUI terminal interface.
- Cross-machine session sync and restore.
- LSP integration.

## Quick Start

### Prerequisites

- Node.js 20+ and npm for normal users.
- [Bun](https://bun.sh/) >= 1.3.14 only if you are developing from source.

### Install

```bash
# Install the published CLI wrapper.
npm install -g jyycode-ai

# Start JYY-Code in the current terminal directory.
jyy
```

`jyy` and `jyycode` point to the same CLI. The process inherits the terminal's current working directory, so running `jyy` from `/path/to/project` starts JYY-Code against `/path/to/project`.

### Configure A Model Provider

Use the /connect command to select a model provider and enter your API key.

You can also use environment variables supported by the selected provider, for example:

```bash
export OPENAI_API_KEY="sk-..."
jyycode models openai
```

Or write the global config file at `~/.config/jyycode/jyycode.jsonc`:

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

Use `provider`, `permission`, and `plugin` as the canonical config keys. The loader also accepts the common plural aliases `providers`, `permissions`, and `plugins` for compatibility.

### Develop From Source

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd jyycode
bun install
bun run dev
```

## Project Structure

```text
jyycode/
|-- packages/
|   |-- jyycode/          # Main app: CLI, agent, session, tools, memory, skills, TUI
|   |-- core/             # Core libraries, filesystem, provider helpers, utilities
|   |-- llm/              # LLM abstraction layer and protocol adapters
|   |-- plugin/           # Plugin SDK and TUI/plugin interfaces
|   |-- sdk/              # Client SDK for the JYYCode API
|   |-- http-recorder/    # HTTP recording/replay test utilities
|   |-- script/           # Shared scripts
|   `-- identity/         # Identity provider assets
|-- .jyycode/             # Project-level config, skills, agents, commands, themes
|-- memory/               # Persistent memory storage
|-- specs/                # Design specs
|-- script/               # Build and CI scripts
`-- patches/              # Patched dependencies
```

## Architecture

```text
CLI Input
  -> Config Loading
  -> Session Restore
  -> System Prompt (skills + memory + tools)
  -> LLM Call (provider selection + streaming)
  -> Tool Execution (permission check + schema validation + execution + truncation)
  -> Post-Turn (memory extraction + persistence + event emission)

Multi-Agent Mode:
  User Request
  -> Cluster Planner
  -> Persisted Plan Tasks
  -> Background Sub-agents
  -> task_status / Review
  -> Final Synthesis
  -> TUI state from persisted cluster rows
```

## Configuration

Project-level configuration lives in `.jyycode/jyycode.jsonc`. Global user config is at `~/.config/jyycode/jyycode.jsonc`.

Key configuration areas:

- **provider** - LLM provider credentials and model preferences.
- **permission** - tool access rules with ask/allow/deny per tool and agent.
- **agent_cluster** - multi-agent orchestration settings, model routing, concurrency, and review rounds.
- **mcp** - MCP server connections.
- **skills** - skill discovery paths.
- **plugin** - TUI and runtime plugin origins.

## Notable API

```http
GET /session/:sessionID/agent-cluster
```

Returns persisted agent cluster runs and tasks for a session. The TUI uses this endpoint during session sync and then keeps state fresh through `agent_cluster.event`.

## License

MIT (c) [JYYCode](https://github.com/Reon-Jin/JYY-Code)
