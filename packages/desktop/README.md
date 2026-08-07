# JYYCode Desktop Preview

JYYCode Desktop is the Tauri GUI for the same local backend, project database, Sessions, messages,
permissions, questions, tools, and Provider configuration used by the JYYCode TUI. The GUI does not open SQLite or
import backend internals; the Tauri host owns an authenticated loopback sidecar and the web UI uses the generated SDK.

## Prerequisites

- Bun 1.3.14 for source development
- Rust stable with the target for the current desktop platform

Windows development requires:

- Windows 10 or 11 x64
- Rust target `x86_64-pc-windows-msvc`
- Visual Studio 2022 Build Tools with Desktop development with C++ and the Windows SDK
- WebView2 Runtime (normally present on supported Windows versions)

Apple Silicon development requires:

- macOS 13 or newer on Apple Silicon
- Xcode Command Line Tools (`xcode-select --install`)
- Rust target `aarch64-apple-darwin`

Install repository dependencies from the root with `bun install --frozen-lockfile`.

## Develop and test

```text
bun run --cwd packages/desktop dev
bun turbo typecheck
bun run --cwd packages/app test
bun run --cwd packages/desktop test
bun run --cwd packages/desktop stage:sidecar
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Development starts Vite and the Tauri shell. The Rust supervisor launches exactly one `jyycode-sidecar`, waits for its
authenticated loopback ready event, and terminates it when the desktop process exits. Backend credentials stay in the
desktop process and are not persisted by the web UI. On macOS, the Tauri host restores the login-shell `PATH` before
starting the backend so apps launched from Finder can still discover Git, language servers, and Homebrew tools.
Tauri validates configured external binaries during its Cargo build script, so a clean checkout must stage the sidecar
before running `cargo test`.

## Plan workflow

The Composer's Multi-Agent switch controls the current root Session. New Sessions inherit the global setting, which is
off by default, until the user explicitly enables or disables it. Both single-agent and multi-agent sessions produce the
same durable plan (goal, steps, tasks, and status); the only difference is that single-agent executes every task itself
instead of dispatching subagents. Plan and Changes share the permanent activity rail on the right; selecting an item
opens its one on-demand drawer without replacing the conversation.

The Plan drawer shows the backend's current plan, progress, and task states. The Subagents panel in the same right rail
edits project profiles, including each profile's description, launch prompt, avatar, model, variant, and enabled state.
A multi-agent task with a child Session can be opened in the main conversation, where the child keeps its assigned Agent
and model but remains writable for direct guidance. The header returns to the root Session, which stays selected in the
Session list while a child is open.

The Composer model button configures the main Agent model and thinking depth. It is used for ordinary single-Agent
prompts and for Multi-Agent planning, coordination, review, and final synthesis. Child models are selected on project
sub-agent profiles in the right rail; changes do not switch models for tasks already running.

Desktop and the TUI share the same Sessions, SQLite-backed state, HTTP API, and SSE events. Actions and progress remain
authoritative in the shared backend and are visible from either interface.

## Home, Skill, and MCP management

The Home screen has a compact global navigation rail for Home, Skill, and MCP. Home can open a directory, create a
project, reopen a recent project, or remove it from the recent list. Opening a project leaves the management shell and
enters the project workspace; the global rail is not shown beside project Sessions.

Skill management shows the effective global Skill set and renders each `SKILL.md`. Managed Skills are stored under
`~/.jyycode/skills/<name>/SKILL.md`; additional local paths and synchronized URLs come from the `skills` section of the
global configuration at `~/.config/jyycode/jyycode.jsonc`. Built-in Skills are read-only and cannot be deleted. Role
skills live under `~/.jyycode/role/<role-id>/skills/<name>/SKILL.md` and are visible only to that role's child Agent.
The right rail can create private role skills with the required frontmatter. Remote URL Skills are also not edited in
place: removing one removes its configured source, not its cached files. Explicit local-path Skills may be edited, but
deletion removes only their selected `SKILL.md`.

MCP management edits the persisted global `mcp` entries in `~/.config/jyycode/jyycode.jsonc`, so its add, edit,
enable/disable, and delete actions apply across projects. The Composer's MCP control remains project-scoped and only
connects or disconnects the MCP servers effective for that project; it does not replace the global management page.
Runtime status, retry, OAuth authentication, and removal of stored authentication are available from global MCP
management.

Treat MCP environment values, headers, OAuth client secrets, and the global configuration file as sensitive. The
Desktop UI does not display an existing client secret and the backend does not log secret field values, but configured
values remain local configuration data and should not be copied into bug reports or committed to source control.

## Settings

Open Settings from the gear at the bottom of the Home management rail or from the gear in a project's Session footer.
Settings is a full-screen route rather than another management panel. Its Back button returns to the caller; when
opened from a Session it returns to that same Session.

Startup location and dark/light theme are desktop-only preferences persisted by the Tauri host. The default permission
policy and default Shell are stored in JYYCode's global backend configuration and therefore apply across projects. A
permission-policy change affects only newly created Sessions; existing Sessions keep their current permission choices.

The Advanced page can ask Windows Explorer or macOS Finder to select the backend-provided global `jyycode.jsonc` file. The Tauri
command accepts only an absolute path whose file name is exactly `jyycode.jsonc` or `jyycode.json`, and launches
the fixed platform file manager with an argument array rather than a shell command. It does not accept an arbitrary
executable or command.

Language switching between Simplified Chinese and English applies immediately and is persisted with the other desktop
preferences. The optional liquid-glass appearance uses Windows 11 Mica, Windows 10 Acrylic, macOS's native
under-window background material, and a solid semantic-color fallback when composition or transparency is unavailable.
Notification categories for completed replies, permission requests, and Agent questions can be enabled independently;
notifications are emitted only while the window is not focused and use generic text so prompt or response content is
not exposed in the system notification center.

Context-compression thresholds are validated before they are saved and apply to newly created Sessions. Memory
management opens dedicated User, Task, and Experience memory pages instead of expanding records in Settings. All pages
support search, editing, deletion, compression, and export. Task memory is shared by every Session in the same
project, while Experience memory is shared across all projects. Exported memory files can contain sensitive
conversation-derived information and should be handled accordingly.

On Windows and Apple Silicon macOS, automatic updating uses Tauri's signed updater with the rolling `desktop-latest`
GitHub Release manifest. Settings offers three policies: automatically install and restart, check and notify, or turn
off automatic checks.
Manual checking and installation remain available for every policy, and update failures never block application
startup. The same channel contains a platform-specific updater entry for each supported target.

Updater signatures verify artifact integrity and publisher continuity, but they are separate from Windows
Authenticode. The 1.0.0 Windows release remains a prerelease until the EXE, sidecar, NSIS installer, and MSI installer are
signed with the production Windows certificate and verified on clean Windows 10 and 11 machines.

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
Normal local builds do not create updater artifacts. The `desktop-release` workflow enables them with the protected
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets, publishes the immutable
versioned artifacts, and replaces `desktop-latest/latest.json`. The private key must also be kept in an audited offline
backup; losing it prevents future updates for existing installations.

To publish a new Desktop version, open **Actions > desktop-release > Run workflow**, select `main`, enter a semantic
version such as `1.0.1`, and run it. The workflow builds and smoke-tests Windows x64 and Apple Silicon macOS in parallel,
creates signed updater artifacts, publishes `desktop-v1.0.1`, and updates the automatic-update channel with both
platforms. It rejects a version whose tag or Release already exists, so every version can be published only once.

## Build locally on Apple Silicon

```bash
xcode-select --install
rustup target add aarch64-apple-darwin
bun install --frozen-lockfile

bun run --cwd packages/desktop stage:sidecar
bun run --cwd packages/app build
bun run --cwd packages/desktop build -- --target aarch64-apple-darwin
bash packages/desktop/script/smoke-macos.sh
```

Outputs are under `packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle`:

- `macos/JYYCode.app` — ad-hoc-signed local application bundle.
- `dmg/*.dmg` — local Apple Silicon disk image.

The desktop build wrapper sets `CI=true` only for macOS packaging. Tauri then skips the optional Finder AppleScript
that positions DMG icons, so local builds do not require Automation permission to control Finder. Windows builds keep
their existing environment and installer behavior.

The GitHub release currently uploads Apple Silicon artifacts but does not provide Apple Developer ID signing or
notarization, and it does not support Intel/Universal builds. Tauri's macOS platform configuration disables hardened
runtime because the embedded Bun sidecar needs JIT execution and the current build does not carry production
entitlements. These are intentional distribution differences; the shared Desktop UI, backend, model configuration,
Multi-Agent behavior, and updater flow are otherwise the same.

## Clean-VM acceptance gate

Before distributing a build, test it on clean Windows 10 and 11 x64 VMs with no Bun, Node.js, or JYYCode installation:

1. Install the app and create a Git project; then open an existing project.
2. Create, rename, archive, and delete Sessions.
3. Complete a multi-turn conversation that includes a tool permission and an Agent question.
4. Stop a response, retry a failed send, restart the app, and confirm the project, Session, and messages return.
5. Open the same directory in the TUI and confirm the same Session and messages are visible.
6. Check 100%, 125%, and 150% DPI at 1024x720 and 1440x900.
7. Exit the app and confirm its owned sidecar process is gone.

For Apple Silicon local acceptance, run the same workflow from both Terminal and Finder, verify Git and user-installed
tools are found, exercise paths containing spaces and non-ASCII characters, reveal the global configuration in Finder,
and confirm the owned sidecar exits with the application.

## Runtime data and troubleshooting

Provider and model configuration is reused from the JYYCode backend in phase 1; configure it with the TUI (`/connect`)
or the existing JYYCode configuration file. Backend logs are stored in JYYCode's data `log` directory (normally
`%LOCALAPPDATA%\jyycode\log` on Windows and `~/.local/share/jyycode/log` on macOS when XDG variables are unset), while
startup failures also surface the sidecar's recent sanitized stderr in the recovery screen. If startup fails, inspect
those logs, confirm the platform webview is available, and verify that endpoint security software did not block the
bundled sidecar.
