# JYY-Code

[![License](https://img.shields.io/github/license/anomalyco/jyycode?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

> AI-powered development tool with communication capabilities — built on OpenCode, inspired by Claude Code.

JYY-Code is an intelligent coding agent that combines multi-agent orchestration, persistent memory, skill learning, and communication features (email/IM) into a unified development assistant. It extends the OpenCode protocol with architectural improvements drawn from Claude Code's design.

## Features

### Multi-Agent Cluster
An orchestrator-planner-reviewer architecture that decomposes complex tasks, dispatches them to specialized sub-agents (researcher, analyst, coder, tester, reviewer, etc.), and synthesizes results. Supports up to 100 sub-agents with configurable concurrency, dependency resolution, and multi-round review.

### Email & Communication
Built-in SMTP/IMAP adapters for sending and receiving emails directly within agent sessions. Supports:
- SMTP (STARTTLS) and SMTPS
- OAuth2 (Microsoft device code flow)
- MIME attachments with automatic content-type detection
- IMAP mailbox polling and session detection

### Hermes-Inspired Memory System
A structured, file-based persistent memory system that captures project facts, engineering conventions, user preferences, and lessons learned across sessions. Features:
- Dual-scope storage (project + user)
- Confidence-rated entries with source tracking
- Automatic post-turn memory extraction
- Search, patch, supersede, and suggest operations

### Skill Learning
Markdown-based skill system that loads domain knowledge, workflows, and tool integrations from local or remote sources. Skills are discovered from `.jyycode/skills/` or fetched via HTTP, with frontmatter metadata for relevance matching.

### Intelligent Tool Search
Token-based relevance scoring for tool discovery — tokenizes queries, scores tools by ID and description match, and returns ranked results. Enables the agent to find the right tool without enumerating the full catalog.

### Architecture Optimizations (inspired by Claude Code)
- **Workflow optimizations** — session management with SQLite persistence, intelligent compaction, post-turn memory extraction, plan-mode execution
- **Worktree management** — git worktree creation, removal, and reset for isolated task execution
- **Tool calling normalization** — standardized tool definitions with schema validation, parameter parsing, output truncation, and permission gating
- **Security constraints** — configurable permission system (ask/allow/deny) with per-agent rules, session-scoped approvals, and shell security guidance

### Additional Capabilities
- **20+ LLM providers** — Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure, GitHub Copilot, OpenRouter, xAI, Groq, Mistral, and more
- **MCP (Model Context Protocol)** — first-class support for tool servers
- **Plugin system** — npm-based and internal plugin architecture with hook system
- **TUI** — terminal user interface built with SolidJS and OpenTUI
- **Session sync** — cross-machine session backup and restore

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3.14

### Install

```bash
# Clone the repository
git clone https://github.com/anomalyco/jyycode.git
cd jyycode

# Install dependencies
bun install

# Run in development mode
bun run dev
```

## Project Structure

```
jyycode/
├── packages/
│   ├── jyycode/          # Main application (CLI, agent, session, tool, memory, skill, etc.)
│   ├── core/             # Core library (AI SDK providers, filesystem, plugin types, utils)
│   ├── llm/              # LLM abstraction layer (provider implementations, protocol adapters)
│   ├── plugin/           # Plugin SDK (types, hooks, interfaces)
│   ├── sdk/              # Client SDK for JYYCode API
│   ├── http-recorder/    # HTTP recording/replay for tests
│   ├── script/           # Shared scripts
│   └── identity/         # Identity provider assets
├── .jyycode/             # Project-level config (skills, agents, commands, tools, themes)
├── memory/               # Persistent memory storage
├── specs/                # Design specs (storage, v2 protocol)
├── script/               # Build and CI scripts
└── patches/              # Patched dependencies
```

## Architecture

```
CLI Input → Config Loading → Session Restore → System Prompt (skills + memory + tools)
  → LLM Call (provider selection → AI SDK streamText)
  → Tool Execution (permission check → schema validation → execute → truncation)
  → Post-Turn (memory extraction → session persistence → event emission)

Multi-Agent Mode:
  Primary Agent → Plan → Dispatcher → Sub-agents (parallel) → Reviewer → Synthesize
```

## Configuration

Project-level configuration lives in `.jyycode/jyycode.jsonc`. Global user config is at `~/.config/jyycode/jyycode.jsonc`.

Key configuration areas:
- **providers** — LLM provider credentials and model preferences
- **permissions** — tool access rules (ask/allow/deny per tool and agent)
- **agent_cluster** — multi-agent orchestration settings
- **mcp** — MCP server connections
- **skills** — skill discovery paths

## License

MIT © [JYYCode](https://github.com/anomalyco/jyycode)
