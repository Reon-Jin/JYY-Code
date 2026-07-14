# JYYCode Desktop (Windows Preview)

JYYCode Desktop is the Windows GUI for the same local backend, project database, Sessions, messages,
permissions, questions, tools, and Provider configuration used by the JYYCode TUI. The GUI does not open SQLite or
import backend internals; the Tauri host owns an authenticated loopback sidecar and the web UI uses the generated SDK.

## Prerequisites

- Windows 10 or 11 x64
- Bun 1.3.14 for source development
- Rust stable with the `x86_64-pc-windows-msvc` target
- Visual Studio 2022 Build Tools with Desktop development with C++ and the Windows SDK
- WebView2 Runtime (normally present on supported Windows versions)

Install repository dependencies from the root with `bun install --frozen-lockfile`.

## Develop and test

```powershell
bun run --cwd packages/desktop dev
bun turbo typecheck
bun run --cwd packages/app test
bun run --cwd packages/desktop test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Development starts Vite and the Tauri shell. The Rust supervisor launches exactly one `jyycode-sidecar`, waits for its
authenticated loopback ready event, and terminates it when the desktop process exits. Backend credentials stay in the
desktop process and are not persisted by the web UI.

## Multi-Agent workflow

The Composer's Multi-Agent switch controls the current root Session. New Sessions inherit the global setting, which is
off by default, until the user explicitly enables or disables it. Todo, Multi-Agent, and Changes share the permanent
activity rail on the right; selecting an item opens its one on-demand drawer without replacing the conversation.

The Multi-Agent drawer shows the backend's current plan, progress, and task states. A task with a child Session can be
opened in the main conversation, where the child keeps its assigned Agent and model but remains writable for direct
guidance. The header returns to the root Session, which stays selected in the Session list while a child is open.

The Composer model button configures four global roles: Main, Simple, Complex, and Visual & Documents. Main is used for
ordinary single-Agent prompts and for Multi-Agent planning, coordination, review, and final synthesis; the other three
roles select models for their corresponding child tasks. Changes apply to every project and do not switch models for
tasks already running.

Desktop and the TUI share the same Sessions, SQLite-backed state, HTTP API, and SSE events. Actions and progress remain
authoritative in the shared backend and are visible from either interface.

## Build a Windows release

```powershell
bun run --cwd packages/desktop stage:sidecar
bun run --cwd packages/app build
bun run --cwd packages/desktop build -- --target x86_64-pc-windows-msvc
pwsh packages/desktop/script/smoke-windows.ps1
```

Outputs are under `packages/desktop/src-tauri/target/x86_64-pc-windows-msvc/release`:

- `jyycode-desktop.exe` — raw executable; the smoke script copies it to `desktop-artifacts/JYYCode-portable-x64.exe`
  together with its required `jyycode-sidecar.exe` companion. Keep both files in the same directory.
- `bundle/nsis/*.exe` — NSIS installer.
- `bundle/msi/*.msi` — MSI installer.
- `desktop-artifacts/SHA256SUMS.txt` — checksums for the portable executable and both installers.

The installers use WebView2's download bootstrapper. Installation needs network access only when WebView2 is absent.
Phase 1 intentionally has no auto-updater and no placeholder signing credentials; public stable distribution is gated
on configured and audited Windows code-signing secrets.

## Clean-VM acceptance gate

Before distributing a build, test it on clean Windows 10 and 11 x64 VMs with no Bun, Node.js, or JYYCode installation:

1. Install the app and create a Git project; then open an existing project.
2. Create, rename, archive, and delete Sessions.
3. Complete a multi-turn conversation that includes a tool permission and an Agent question.
4. Stop a response, retry a failed send, restart the app, and confirm the project, Session, and messages return.
5. Open the same directory in the TUI and confirm the same Session and messages are visible.
6. Check 100%, 125%, and 150% DPI at 1024x720 and 1440x900.
7. Exit the app and confirm its owned sidecar process is gone.

## Runtime data and troubleshooting

Provider and model configuration is reused from the JYYCode backend in phase 1; configure it with the TUI (`/connect`)
or the existing JYYCode configuration file. Backend logs are stored in JYYCode's data `log` directory (normally
`%LOCALAPPDATA%\jyycode\log` on Windows), while startup failures also surface the sidecar's recent sanitized stderr in
the recovery screen. If startup fails, inspect those logs, confirm WebView2 is installed, and verify that endpoint
security software did not block the bundled sidecar.
