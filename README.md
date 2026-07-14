# JYY-Code

[![Release](https://img.shields.io/github/v/release/Reon-Jin/JYY-Code?style=flat-square)](https://github.com/Reon-Jin/JYY-Code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[中文](README-zh.md) · [English](README.md)

<p align="center">
  <img src="./logo/logo.gif" alt="JYY-Code" width="500" />
</p>

> **Keep AI moving through real projects until the work is ready to ship.**

JYY-Code is an AI engineering environment for real software and documentation work. It brings project context, engineering tools, session state, durable memory, and agent collaboration into one workflow, so complex work can keep moving toward verifiable deliverables.

[Get started](#quick-start) · [View releases](https://github.com/Reon-Jin/JYY-Code/releases)

## Ship Real Work

JYY-Code ties completion to executable plans, tracked tasks, concrete artifacts, and recorded review decisions. For complex goals, it routes work to the right agents and tracks every step's dependencies, status, and outcome.

```text
Goal → Plan → Execute → Review → Revise → Deliver
```

When a specialist agent submits its work, the primary agent checks the actual artifacts against explicit acceptance criteria. Work that falls short goes back to the same agent with concrete issues to address. Only accepted results can move into the final synthesis.

Project, session, task, and review state are persisted as the work progresses. After an interruption, you can reopen the existing session and continue with the saved conversation and task state.

JYY-Code carries work through to a deliverable result.

## Quick Start

### Install and launch

JYY-Code requires Node.js 20+ and npm.

```bash
npm install -g jyycode-ai@latest
cd /path/to/your/project
jyy
```

On first launch, JYY-Code automatically downloads the binary for your operating system and processor architecture.

`jyy` and `jyycode` are aliases for the same command. The directory you launch it from becomes the agent workspace.

### Connect a model

Once JYY-Code is running, enter:

```text
/connect
```

Choose a model provider and follow the prompts to connect it. You can then start working directly in the current project.

For example:

```text
Trace this project's authentication flow, find a reproducible issue, fix it, and run the relevant tests.
```

### Take on complex work

A single agent handles everyday tasks by default. For work that spans research, implementation, testing, and review, press **F9** to enable the Multi-Agent workflow.

Run `/cluster` to choose separate models for planning, complex tasks, simple tasks, and visual work. JYY-Code will build an execution plan, delegate the work, and produce the final delivery only after every result has passed review.

## Work Directly in Real Projects

JYY-Code works in the project directory itself. It uses the project structure, local instructions, code search, LSP, and Git context to understand the environment, then applies changes and verifies them with file editing, shell commands, and engineering tools.

- **Understand the project:** Read its structure, development instructions, dependencies, and existing implementation.
- **Make and verify changes:** Edit files, run commands and tests, and keep iterating on the results.
- **Keep work continuous:** Persist projects, sessions, messages, task state, and durable memory.
- **Control critical actions:** Require approval for sensitive operations and ask focused questions when information is missing.
- **Use your existing toolchain:** Connect model providers, MCP servers, skills, and plugins.

## Coordinated Multi-Agent Work

JYY-Code breaks complex goals into tasks with explicit dependencies, acceptance criteria, and expected artifacts. The primary agent owns planning, review decisions, and final synthesis, while specialist agents handle research, implementation, testing, analysis, and visual work.

- **Focused task briefs:** Each agent receives its scope, relevant predecessor results, downstream requirements, acceptance criteria, and unresolved review issues.
- **Step-level execution:** Tasks within the same step can run in parallel. The next step begins after every task in the current step has been accepted.
- **Explicit review decisions:** The primary agent checks submitted work against the acceptance criteria and verifies the expected artifacts.
- **Continuous revisions:** Work that needs changes returns to the same agent session with its existing context and a concrete revision brief.
- **Role-based model routing:** Planning, complex tasks, simple tasks, and visual work can use different models.
- **Isolated parallel changes:** Coding tasks can use separate Git worktrees to reduce conflicts between concurrent agents.

Once every planned task has passed review, the primary agent assembles the results into a consistent final delivery.

## Persistent Work State

JYY-Code persists projects, sessions, messages, todos, cluster runs, tasks, and events in SQLite. After a restart, `/sessions` reopens existing sessions with their conversation and task state, allowing you to continue with the saved context.

Structured memory tracks the active goal, verified outcomes, and durable user preferences. It records the current objective at the start of a turn and updates the delivered result when the work is complete. The primary agent owns long-term memory updates, while specialist agents receive the context relevant to their tasks.

Use the following command to inspect the active database, release channel, migration state, and session counts:

```bash
jyycode db status
```

This command is read-only. Packaged releases and source-development environments use separate databases.

## Permissions and Local Data

JYY-Code applies permission rules by tool, agent, and session. Each operation can be configured as `ask`, `allow`, or `deny`. Operations that require confirmation generate a permission request before execution.

The project directory serves as the default agent workspace. File operations, shell commands, access to external directories, and other tool calls follow the applicable permission policy.

Credentials added through `/connect` are stored in `auth.json` under the JYY-Code data directory with restricted file permissions. Model requests are handled by the connected provider. Project files, sessions, and runtime state are managed by the local backend.

## Configuration and Extensions

The global configuration file is located at:

```text
~/.config/jyycode/jyycode.jsonc
```

Project-specific configuration lives at:

```text
.jyycode/jyycode.jsonc
```

Minimal example:

```jsonc
{
  "model": "openai/gpt-5",
  "permission": {
    "*": "ask",
  },
  "agent_cluster": {
    "default_on": false,
    "max_concurrency": 4,
  },
}
```

Configuration covers:

- model providers and the default model;
- tool and directory permissions;
- Multi-Agent model routing, concurrency, and review limits;
- MCP servers;
- skills;
- plugins and hooks.

Credentials can be managed separately through `/connect`.

## Interfaces

Every JYY-Code interface uses the same project and runtime data.

| Interface       | Status          | Scope                                                                                              |
| --------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| CLI / TUI       | Fully supported | Single-agent and Multi-Agent workflows, model configuration, and the complete engineering workflow |
| Windows Desktop | Preview         | Projects, sessions, conversations, tool calls, permission requests, and agent questions            |

The CLI / TUI supports macOS, Linux, and Windows, with builds for x64 and arm64.

Windows Desktop currently provides a single-agent interface backed by the local JYY-Code runtime. Development requirements, build commands, and runtime details are documented in [`packages/desktop/README.md`](packages/desktop/README.md).

## Develop from Source

Source development requires Bun 1.3.14.

```bash
git clone https://github.com/Reon-Jin/JYY-Code.git
cd JYY-Code
bun install
bun run dev
```

The repository is organized as a Bun workspace:

```text
packages/jyycode/   Agent runtime, sessions, memory, tools, and TUI
packages/app/       Graphical interface
packages/desktop/   Desktop shell and local sidecar
packages/core/      Filesystem, providers, and shared infrastructure
packages/llm/       LLM protocols and runtime adapters
packages/plugin/    Plugin SDK and extension interfaces
packages/sdk/       JYY-Code API client
```

See [`packages/desktop/README.md`](packages/desktop/README.md) for the Desktop development workflow.

## Acknowledgements

JYY-Code began as a fork of [OpenCode](https://github.com/anomalyco/opencode) and has since evolved with persistent work state, coordinated Multi-Agent execution, review gates, and delivery workflows.

JYY-Code is an independent open-source project and is not affiliated with or endorsed by the OpenCode team.

## Feedback

Use [GitHub Issues](https://github.com/Reon-Jin/JYY-Code/issues) to report bugs or propose features.

## License

JYY-Code is available under the [MIT License](LICENSE).
