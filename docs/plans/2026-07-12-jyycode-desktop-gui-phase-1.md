# JYYCode Windows Desktop GUI Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Windows-first Tauri desktop application that opens or creates projects, manages sessions, and supports persistent single-Agent conversations while sharing JYYCode's existing backend, SDK, database, and event protocol with the TUI.

**Architecture:** Add a pure SolidJS client in `packages/app` and a narrow Tauri shell in `packages/desktop`. The Rust shell owns a bundled `jyycode serve` sidecar and returns an authenticated loopback endpoint to the GUI; all project, session, Agent, message, permission, and question behavior remains in `packages/jyycode` and is accessed through `@jyycode-ai/sdk/v2` plus SSE.

**Tech Stack:** Bun 1.3.x, TypeScript 5.8, SolidJS 1.9, Vite 8, TanStack Solid Query 5, Vitest 4, Solid Testing Library, Tauri 2.11, Rust 2024 edition, JYYCode v2 SDK/API, SSE, CSS custom properties.

---

## Read this first

- Use `@Code` and `@efficiency` while implementing TypeScript/Rust tasks.
- Use `@ui-ux-pro-max` for Tasks 3, 8, 9, 11, and 12.
- Use `@security-auditor` for Tasks 5, 6, 7, and 15.
- Follow [the validated design](./2026-07-12-jyycode-desktop-gui-design.md).
- Do not restore the deleted historical Electron implementation from commit `cb7de59^`; create fresh Tauri/Solid files.
- Do not import `packages/jyycode/src/**` from `packages/app`. The only business boundary is `@jyycode-ai/sdk/v2`.
- Keep Multi-Agent, worktrees, terminal, file explorer, diff editor, sharing, compaction, session fork, and auto-update out of phase 1.
- Run package tests from their package directory. The root `test` script intentionally fails.

## One-time Windows prerequisites

1. Install Visual Studio Build Tools 2022 with “Desktop development with C++” and the Windows 10/11 SDK.
2. Install Rust using rustup, then run:

```powershell
rustup default stable
rustup target add x86_64-pc-windows-msvc
rustc --version
cargo --version
```

Expected: both version commands succeed. The current planning workstation did not have Cargo installed, so this gate must be completed before Task 4.

3. Keep Bun at the repository-declared `1.3.14` version and run `bun install` once from the repository root.

## Pinned dependency additions

Add these exact versions to the root workspace catalog unless the repository upgrades them first:

```json
{
  "@fontsource-variable/inter": "5.2.8",
  "@fontsource-variable/jetbrains-mono": "5.2.8",
  "@solidjs/router": "0.16.1",
  "@solidjs/testing-library": "0.8.10",
  "@tanstack/solid-query": "5.101.2",
  "@tauri-apps/api": "2.11.1",
  "@tauri-apps/cli": "2.11.4",
  "@tauri-apps/plugin-dialog": "2.7.1",
  "@tauri-apps/plugin-store": "2.4.3",
  "@testing-library/jest-dom": "6.9.1",
  "@testing-library/user-event": "14.6.1",
  "dompurify": "3.4.12",
  "jsdom": "29.1.1",
  "lucide-solid": "1.24.0",
  "vite": "8.1.4",
  "vite-plugin-solid": "2.11.12",
  "vitest": "4.1.10"
}
```

Continue using the existing catalog versions of `solid-js`, `marked`, TypeScript, and Node types to avoid duplicate runtime copies.

### Task 1: Add a machine-readable server-ready handshake

**Files:**

- Modify: `packages/jyycode/src/cli/cmd/serve.ts:9`
- Modify: `packages/jyycode/test/lib/cli-process.ts:50`
- Modify: `packages/jyycode/test/cli/serve/serve-process.test.ts:12`

**Step 1: Write the failing subprocess test**

Add a test that starts the real CLI with JSON mode. This must use the subprocess harness so it covers argv parsing, actual port selection, stdout framing, and HTTP readiness.

```ts
cliIt.live(
  "prints a machine-readable ready event",
  ({ jyycode }) =>
    Effect.gen(function* () {
      const server = yield* jyycode.serve({ json: true })
      expect(server.ready).toEqual({
        type: "server.ready",
        hostname: server.hostname,
        port: server.port,
      })
      expect(server.url).toBe(`http://${server.hostname}:${server.port}`)
    }),
  60_000,
)
```

Extend the harness types first so the test compiles:

```ts
export type ServeOpts = SpawnOpts & {
  readonly port?: number
  readonly hostname?: string
  readonly extraArgs?: string[]
  readonly readyTimeoutMs?: number
  readonly json?: boolean
}

export type ServeReady = {
  readonly type: "server.ready"
  readonly hostname: string
  readonly port: number
}

export type ServeHandle = {
  readonly url: string
  readonly hostname: string
  readonly port: number
  readonly ready: ServeReady
  readonly kill: () => void
  readonly exited: Promise<number>
}
```

**Step 2: Run the test and verify it fails**

Run:

```powershell
cd packages/jyycode
bun test test/cli/serve/serve-process.test.ts --timeout 60000
```

Expected: FAIL because `serve --json` is unknown or no JSON ready event is parsed.

**Step 3: Add the `--json` option and ready payload**

Change `ServeCommand.builder` and the ready output:

```ts
const readyOption = {
  json: {
    type: "boolean" as const,
    default: false,
    describe: "print a machine-readable server.ready event",
  },
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs).options(readyOption),
  describe: "starts a headless jyycode server",
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.JYYCODE_SERVER_PASSWORD) {
      console.log("Warning: JYYCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const ready = {
      type: "server.ready" as const,
      hostname: server.hostname,
      port: server.port,
    }
    console.log(args.json ? JSON.stringify(ready) : `jyycode server listening on http://${server.hostname}:${server.port}`)
    yield* Effect.never
  }),
})
```

Do not include the password, data directory, PID, or project path in the ready event.

**Step 4: Teach the subprocess harness to parse either format**

In `jyycode.serve`, push `--json` when requested and replace the single regex branch with:

```ts
if (opts?.json) argv.push("--json")

function parseServeReady(line: string): ServeReady | undefined {
  try {
    const value = JSON.parse(line) as Partial<ServeReady>
    if (value.type === "server.ready" && typeof value.hostname === "string" && Number.isInteger(value.port)) {
      return { type: "server.ready", hostname: value.hostname, port: value.port! }
    }
  } catch {}

  const match = line.match(/listening on http:\/\/([^\s:]+):(\d+)/)
  if (!match) return
  return { type: "server.ready", hostname: match[1], port: Number(match[2]) }
}
```

Resolve the deferred with `{ ready, url: `http://${ready.hostname}:${ready.port}` }`, and expose `ready` on `ServeHandle`.

**Step 5: Run focused and regression tests**

Run:

```powershell
cd packages/jyycode
bun test test/cli/serve/serve-process.test.ts --timeout 60000
bun test test/server/httpapi-listen.test.ts test/server/auth.test.ts --timeout 30000
```

Expected: all tests PASS; human-readable `serve` startup remains compatible.

**Step 6: Commit**

```powershell
git add packages/jyycode/src/cli/cmd/serve.ts packages/jyycode/test/lib/cli-process.ts packages/jyycode/test/cli/serve/serve-process.test.ts
git commit -m "feat(server): add machine-readable ready handshake"
```

### Task 2: Scaffold the standalone SolidJS GUI package

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `packages/app/package.json`
- Create: `packages/app/tsconfig.json`
- Create: `packages/app/vite.config.ts`
- Create: `packages/app/index.html`
- Create: `packages/app/src/index.tsx`
- Create: `packages/app/src/app.tsx`
- Create: `packages/app/src/test/setup.ts`
- Create: `packages/app/src/app.test.tsx`

**Step 1: Add the failing application-shell test**

```tsx
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { App } from "./app"

describe("App", () => {
  it("shows a non-blank startup state", () => {
    render(() => <App />)
    expect(screen.getByRole("status")).toHaveTextContent("正在启动 JYYCode")
  })
})
```

**Step 2: Create package and test configuration**

Use this package shape:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@jyycode-ai/app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fontsource-variable/inter": "catalog:",
    "@fontsource-variable/jetbrains-mono": "catalog:",
    "@jyycode-ai/sdk": "workspace:*",
    "@solidjs/router": "catalog:",
    "@tanstack/solid-query": "catalog:",
    "@tauri-apps/api": "catalog:",
    "@tauri-apps/plugin-dialog": "catalog:",
    "@tauri-apps/plugin-store": "catalog:",
    "dompurify": "catalog:",
    "lucide-solid": "catalog:",
    "marked": "catalog:",
    "solid-js": "catalog:"
  },
  "devDependencies": {
    "@solidjs/testing-library": "catalog:",
    "@testing-library/jest-dom": "catalog:",
    "@testing-library/user-event": "catalog:",
    "@types/node": "catalog:",
    "jsdom": "catalog:",
    "typescript": "catalog:",
    "vite": "catalog:",
    "vite-plugin-solid": "catalog:",
    "vitest": "catalog:"
  }
}
```

`vite.config.ts` must use `base: "./"` so the same assets work in Tauri and when embedded by the existing JYYCode build:

```ts
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { fileURLToPath, URL } from "node:url"

export default defineConfig({
  base: "./",
  plugins: [solid()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
})
```

`src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest"
```

**Step 3: Run the test and verify it fails**

Run:

```powershell
bun install
cd packages/app
bun run test
```

Expected: FAIL because `App` does not yet exist or does not expose the expected startup status.

**Step 4: Implement the minimal entry point**

`src/app.tsx`:

```tsx
export function App() {
  return <main role="status">正在启动 JYYCode…</main>
}
```

`src/index.tsx`:

```tsx
import { render } from "solid-js/web"
import { App } from "./app"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root")
render(() => <App />, root)
```

Create a normal Vite `index.html` with `<div id="root"></div>` and a module script for `/src/index.tsx`.

**Step 5: Verify package tooling**

Run:

```powershell
cd packages/app
bun run test
bun run typecheck
bun run build
```

Expected: test PASS, typecheck exits 0, and `packages/app/dist/index.html` exists.

**Step 6: Commit**

```powershell
git add package.json bun.lock packages/app
git commit -m "feat(gui): scaffold SolidJS application"
```

### Task 3: Establish the visual system and accessible primitives

**Files:**

- Create: `packages/app/src/styles/tokens.css`
- Create: `packages/app/src/styles/global.css`
- Create: `packages/app/src/styles/contrast.ts`
- Create: `packages/app/src/styles/contrast.test.ts`
- Create: `packages/app/src/components/ui/button.tsx`
- Create: `packages/app/src/components/ui/button.test.tsx`
- Create: `packages/app/src/components/ui/dialog.tsx`
- Create: `packages/app/src/components/ui/inline-error.tsx`
- Create: `packages/app/src/components/ui/spinner.tsx`
- Modify: `packages/app/src/index.tsx`

**Step 1: Write failing contrast and keyboard tests**

```ts
import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text", () => {
    expect(contrastRatio("#E7EEF7", "#07111F")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#8DA2B8", "#0B192B")).toBeGreaterThanOrEqual(4.5)
  })
})
```

```tsx
it("gives icon-only buttons an accessible name", () => {
  render(() => <IconButton label="新建 Session"><Plus aria-hidden="true" /></IconButton>)
  expect(screen.getByRole("button", { name: "新建 Session" })).toBeVisible()
})
```

**Step 2: Run tests and verify failure**

Run: `bun run --cwd packages/app test`

Expected: FAIL because tokens and primitives do not exist.

**Step 3: Implement the palette and spacing tokens**

`tokens.css` must define the approved values and semantic focus/error tokens:

```css
:root {
  color-scheme: dark;
  --color-bg: #07111f;
  --color-panel: #0b192b;
  --color-surface: #10243a;
  --color-surface-hover: #14304b;
  --color-accent: #22c997;
  --color-accent-hover: #36d9aa;
  --color-accent-ink: #031711;
  --color-text: #e7eef7;
  --color-text-muted: #8da2b8;
  --color-border: #1a3148;
  --color-danger: #f87171;
  --color-warning: #fbbf24;
  --focus-ring: 0 0 0 3px rgb(34 201 151 / 28%);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --motion-fast: 120ms;
  --motion-normal: 180ms;
}
```

Import Fontsource variable fonts in `index.tsx`, then tokens and global CSS. Use Inter for UI and JetBrains Mono for code with the Windows-local fallback stacks from the design.

**Step 4: Implement `contrastRatio` completely**

```ts
function luminance(hex: string) {
  const channels = hex.slice(1).match(/.{2}/g)
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`)
  const [r, g, b] = channels.map((value) => {
    const channel = Number.parseInt(value, 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}
```

**Step 5: Implement semantic primitives**

Use native `<button>` and `<dialog>` elements. `IconButton` requires a non-empty `label`, renders `aria-label`, and never uses color alone for state. Buttons must expose `data-variant`, loading text, visible `:focus-visible`, and disabled semantics. `Dialog` must return focus to its trigger on close and close on Escape.

**Step 6: Verify visual foundations**

Run:

```powershell
cd packages/app
bun run test
bun run typecheck
bun run build
```

Expected: all PASS. Manually inspect the startup screen at 100%, 125%, and 150% Windows scaling; focus rings remain visible.

**Step 7: Commit**

```powershell
git add packages/app/src
git commit -m "feat(gui): add accessible desktop design system"
```

### Task 4: Scaffold the Tauri shell and deterministic sidecar staging

**Files:**

- Create: `packages/desktop/package.json`
- Create: `packages/desktop/script/stage-sidecar.ts`
- Create: `packages/desktop/script/stage-sidecar.test.ts`
- Create: `packages/desktop/src-tauri/Cargo.toml`
- Create: `packages/desktop/src-tauri/Cargo.lock`
- Create: `packages/desktop/src-tauri/build.rs`
- Create: `packages/desktop/src-tauri/tauri.conf.json`
- Create: `packages/desktop/src-tauri/capabilities/main.json`
- Create: `packages/desktop/src-tauri/src/main.rs`
- Create: `packages/desktop/src-tauri/src/lib.rs`
- Create: `packages/desktop/src-tauri/icons/*`
- Modify: `package.json`
- Modify: `bun.lock`

**Step 1: Write the failing staging-script tests**

```ts
import { describe, expect, it } from "bun:test"
import { sidecarName, sourceBinary } from "./stage-sidecar"

describe("sidecar staging", () => {
  it("uses Tauri's Windows x64 target-triple suffix", () => {
    expect(sidecarName("x64")).toBe("jyycode-sidecar-x86_64-pc-windows-msvc.exe")
  })

  it("selects the existing Bun-compiled Windows binary", () => {
    expect(sourceBinary("x64").replaceAll("\\", "/").endsWith(
      "/packages/jyycode/dist/jyycode-windows-x64/bin/jyycode.exe",
    )).toBe(true)
  })
})
```

**Step 2: Run and verify failure**

Run: `bun test packages/desktop/script/stage-sidecar.test.ts`

Expected: FAIL because the staging module does not exist.

**Step 3: Implement deterministic staging**

Export pure path helpers, then in the script entry point:

1. Reject non-Windows and non-x64 hosts for phase 1.
2. Run `bun run --cwd ../jyycode build --single --skip-embed-web-ui` unless `--skip-build` is passed.
3. Verify the source executable exists and runs `--version` successfully.
4. Create `src-tauri/binaries`.
5. Copy to `jyycode-sidecar-x86_64-pc-windows-msvc.exe`.

Use `Bun.spawn`/`Bun.spawnSync` and `fs.copyFile`; never construct a shell command from paths.

**Step 4: Create Tauri package manifests**

`packages/desktop/package.json`:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@jyycode-ai/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "stage:sidecar": "bun script/stage-sidecar.ts",
    "test": "bun test script",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@tauri-apps/cli": "catalog:",
    "@types/node": "catalog:",
    "typescript": "catalog:"
  }
}
```

Use these Rust dependency constraints in `Cargo.toml` and commit the generated lockfile:

```toml
[package]
name = "jyycode-desktop"
version = "0.1.0"
description = "JYYCode Windows desktop application"
edition = "2024"

[lib]
name = "jyycode_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = "=2.6.3"

[dependencies]
rand = "=0.10.2"
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
tauri = "=2.11.5"
tauri-plugin-dialog = "=2.7.1"
tauri-plugin-shell = "=2.3.5"
tauri-plugin-store = "=2.4.3"
tokio = { version = "1", features = ["sync", "time"] }
```

**Step 5: Configure the Windows shell**

Set:

- Product: `JYYCode`
- Identifier: `ai.jyycode.desktop`
- Main window: 1280x820, minimum 960x640.
- `devUrl`: `http://127.0.0.1:5173`
- `frontendDist`: `../../app/dist`
- `externalBin`: `binaries/jyycode-sidecar`
- Bundle targets: `nsis` and `msi`
- WebView2: `downloadBootstrapper`
- CSP: local assets only, images `self/data`, and `connect-src http://127.0.0.1:*`.

The main capability must include only core defaults, `dialog:allow-open`, and store read/write permissions. Do not grant the WebView shell execution or general filesystem access.

Generate icons from `packages/identity/mark-512x512.png`:

```powershell
cd packages/desktop
bunx tauri icon ../identity/mark-512x512.png -o src-tauri/icons
```

**Step 6: Verify the shell skeleton**

Run:

```powershell
bun install
bun test packages/desktop/script/stage-sidecar.test.ts
cd packages/desktop/src-tauri
cargo test
cargo check
```

Expected: staging tests PASS and the empty Tauri shell compiles. Do not run a foreground `tauri dev` in automation.

**Step 7: Commit**

```powershell
git add package.json bun.lock packages/desktop
git commit -m "feat(desktop): scaffold Tauri Windows shell"
```

### Task 5: Implement secure sidecar supervision and project-directory creation

**Files:**

- Create: `packages/desktop/src-tauri/src/backend.rs`
- Create: `packages/desktop/src-tauri/src/project_path.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs`
- Modify: `packages/desktop/src-tauri/capabilities/main.json`

**Step 1: Write failing Rust unit tests**

Cover ready parsing and path validation:

```rust
#[test]
fn parses_ready_line() {
    let ready = parse_ready(r#"{"type":"server.ready","hostname":"127.0.0.1","port":49152}"#).unwrap();
    assert_eq!(ready.hostname, "127.0.0.1");
    assert_eq!(ready.port, 49152);
}

#[test]
fn rejects_unsafe_windows_project_names() {
    for name in ["..", "a/b", "a\\b", "CON", "name.", "name ", "a:b"] {
        assert!(validate_project_name(name).is_err(), "accepted {name}");
    }
    assert_eq!(validate_project_name("my-project").unwrap(), "my-project");
}
```

**Step 2: Run tests and verify failure**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`

Expected: FAIL because the modules/functions do not exist.

**Step 3: Implement ready parsing and bootstrap types**

```rust
#[derive(Clone, Debug, serde::Deserialize)]
struct ReadyLine {
    #[serde(rename = "type")]
    kind: String,
    hostname: String,
    port: u16,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    base_url: String,
    username: String,
    password: String,
}

fn parse_ready(line: &str) -> Result<ReadyLine, String> {
    let value: ReadyLine = serde_json::from_str(line).map_err(|error| error.to_string())?;
    if value.kind != "server.ready" || value.hostname != "127.0.0.1" || value.port == 0 {
        return Err("invalid server.ready payload".into());
    }
    Ok(value)
}
```

**Step 4: Implement the supervisor state machine**

Use an `Arc`-backed managed state with these explicit phases:

```rust
enum BackendPhase {
    Starting,
    Ready(DesktopBootstrap),
    Failed(String),
    Stopped,
}
```

`start` must:

1. Return early if a child is already owned.
2. Generate a 32-byte random password and hex-encode it.
3. Spawn only the configured `jyycode-sidecar` with fixed arguments `serve --json --hostname 127.0.0.1 --port 0`.
4. Pass `JYYCODE_SERVER_USERNAME=jyycode`, `JYYCODE_SERVER_PASSWORD=<random>`, and no secret command-line arguments.
5. Parse stdout until `server.ready`; retain at most the last 200 stderr lines with secrets redacted.
6. Transition to `Failed` if ready is not received within 20 seconds or the process exits.
7. Permit one automatic restart after an unexpected runtime exit, then remain failed.

Expose only:

```rust
#[tauri::command]
async fn desktop_bootstrap(state: tauri::State<'_, BackendSupervisor>) -> Result<DesktopBootstrap, String>;

#[tauri::command]
async fn restart_backend(app: tauri::AppHandle, state: tauri::State<'_, BackendSupervisor>) -> Result<(), String>;
```

On `RunEvent::Exit`/`ExitRequested`, call `stop` and kill the owned child if it has not exited. The Rust layer, not JavaScript, owns `CommandChild`.

**Step 5: Implement narrow project-directory validation**

`validate_project_name` must reject empty names, `.`/`..`, path separators, Windows-invalid characters, trailing dot/space, and reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive).

`create_project_directory` must canonicalize an existing parent selected through the dialog, join the validated single component, reject an existing target, call `create_dir` once, canonicalize the result, and verify `result.starts_with(parent)` before returning a UTF-8 path.

```rust
#[tauri::command]
fn create_project_directory(parent: String, name: String) -> Result<String, String>;
```

Do not initialize Git here; the GUI will call `project.initGit` through the shared backend.

**Step 6: Register commands and least-privilege plugins**

Initialize shell, dialog, and store plugins. Manage one `BackendSupervisor`. Register exactly the three custom commands above. Restrict the generated command manifest/capability to the main window.

**Step 7: Verify Rust behavior**

Run:

```powershell
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Expected: all PASS with no warnings.

**Step 8: Commit**

```powershell
git add packages/desktop/src-tauri
git commit -m "feat(desktop): supervise authenticated JYYCode sidecar"
```

### Task 6: Add a testable desktop platform bridge and recent-project storage

**Files:**

- Create: `packages/app/src/platform/types.ts`
- Create: `packages/app/src/platform/tauri.ts`
- Create: `packages/app/src/platform/browser.ts`
- Create: `packages/app/src/platform/context.tsx`
- Create: `packages/app/src/platform/recent-projects.ts`
- Create: `packages/app/src/platform/recent-projects.test.ts`
- Modify: `packages/app/src/app.tsx`

**Step 1: Write failing recency and normalization tests**

```ts
it("deduplicates Windows paths case-insensitively and caps the list", () => {
  const result = touchRecentProject(
    Array.from({ length: 12 }, (_, i) => ({ path: `C:\\work\\p${i}`, usedAt: i })),
    "c:\\WORK\\p5",
    20,
  )
  expect(result[0]).toEqual({ path: "c:\\WORK\\p5", usedAt: 20 })
  expect(result).toHaveLength(10)
  expect(result.filter((item) => item.path.toLowerCase().endsWith("p5"))).toHaveLength(1)
})
```

**Step 2: Define the bridge contract**

```ts
export type DesktopBootstrap = {
  baseUrl: string
  username: string
  password: string
}

export type RecentProject = { path: string; usedAt: number }

export interface DesktopBridge {
  bootstrap(): Promise<DesktopBootstrap>
  restartBackend(): Promise<void>
  chooseDirectory(): Promise<string | undefined>
  createProjectDirectory(parent: string, name: string): Promise<string>
  loadRecentProjects(): Promise<RecentProject[]>
  saveRecentProjects(projects: RecentProject[]): Promise<void>
  loadLastLocation(): Promise<{ project?: string; sessionID?: string }>
  saveLastLocation(value: { project?: string; sessionID?: string }): Promise<void>
}
```

The Tauri implementation uses `invoke`, dialog `open({ directory: true, multiple: false })`, and `Store.load("desktop.json")`. The browser implementation returns a clear unsupported error for filesystem operations and uses `localStorage` only for component/integration tests.

**Step 3: Run test and verify failure**

Run: `bun run --cwd packages/app test`

Expected: FAIL because recency helpers and bridge are missing.

**Step 4: Implement path recency and context**

Normalize only for comparison; preserve the newest display path. Sort descending by `usedAt`, remove duplicates, and cap at ten. Never save `DesktopBootstrap` or the password.

The platform context accepts an injected bridge for tests and chooses Tauri only when `window.__TAURI_INTERNALS__` exists.

**Step 5: Verify bridge tests and type safety**

Run:

```powershell
cd packages/app
bun run test
bun run typecheck
```

Expected: PASS. Inspect the compiled code to ensure no backend password is written to store calls.

**Step 6: Commit**

```powershell
git add packages/app/src/platform packages/app/src/app.tsx
git commit -m "feat(gui): add desktop bridge and recent projects"
```

### Task 7: Build the authenticated SDK, query cache, and SSE event bridge

**Files:**

- Create: `packages/app/src/data/sdk.ts`
- Create: `packages/app/src/data/query-client.ts`
- Create: `packages/app/src/data/query-keys.ts`
- Create: `packages/app/src/data/event-bridge.ts`
- Create: `packages/app/src/data/event-bridge.test.ts`
- Create: `packages/app/src/data/context.tsx`
- Modify: `packages/app/src/app.tsx`

**Step 1: Write failing query-key and event-routing tests**

```ts
it("includes directory in every project-scoped key", () => {
  expect(keys.sessions("C:\\a")).toEqual(["project", "c:\\a", "sessions"])
  expect(keys.messages("C:\\a", "ses_1")).toEqual(["project", "c:\\a", "session", "ses_1", "messages"])
})

it("ignores events from a different project directory", () => {
  const action = routeEvent("C:\\a", {
    directory: "C:\\b",
    payload: { id: "evt", type: "session.updated", properties: { sessionID: "s", info: session } },
  } as GlobalEvent)
  expect(action).toEqual([])
})
```

**Step 2: Implement authenticated client creation**

```ts
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"

export function authorizationHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`
}

export function createDesktopClient(input: DesktopBootstrap, directory?: string) {
  return createJyycodeClient({
    baseUrl: input.baseUrl,
    directory,
    headers: { Authorization: authorizationHeader(input.username, input.password) },
  })
}
```

Do not put credentials in URLs. Ensure the header is applied to both normal requests and the SDK's async-iterable SSE request.

**Step 3: Implement cache policy**

Create one `QueryClient` per backend process generation. Use a 30-second default `staleTime`, no mutation retries, and at most two query retries for network failures. All keys start with the normalized directory.

**Step 4: Implement SSE routing with frame batching**

`EventBridge` must:

1. Call `client.global.event({ sseMaxRetryAttempts: 0 })`.
2. Filter `GlobalEvent.directory` against the selected directory.
3. Queue events and flush them at most once per `requestAnimationFrame`.
4. Patch exact caches for message/part/session/status/permission/question events.
5. Invalidate instead of guessing when an event's target is absent.
6. Reconnect with 1s, 2s, 4s, 8s, then 30s maximum backoff.
7. On `server.connected` after a disconnect, invalidate sessions, current messages, permissions, questions, and status before marking the connection healthy.
8. Abort immediately when project, bootstrap generation, or component lifecycle changes.

Keep `routeEvent` and conversation patching pure so they can be tested with duplicate and out-of-order events.

**Step 5: Run focused tests**

Run:

```powershell
cd packages/app
bun run test -- src/data/event-bridge.test.ts
bun run typecheck
```

Expected: PASS; fake timers verify backoff is capped and no timer survives abort.

**Step 6: Run the existing server event contract tests**

Run:

```powershell
cd packages/jyycode
bun test test/server/httpapi-event.test.ts test/server/httpapi-cors.test.ts test/server/auth.test.ts --timeout 30000
```

Expected: PASS. Tauri origins remain allowed and auth remains required when a password exists.

**Step 7: Commit**

```powershell
git add packages/app/src/data packages/app/src/app.tsx
git commit -m "feat(gui): connect authenticated SDK and SSE cache"
```

### Task 8: Implement project onboarding and startup routing

**Files:**

- Create: `packages/app/src/features/projects/project-controller.ts`
- Create: `packages/app/src/features/projects/project-controller.test.ts`
- Create: `packages/app/src/features/projects/project-context.tsx`
- Create: `packages/app/src/features/projects/welcome-page.tsx`
- Create: `packages/app/src/features/projects/project-create-dialog.tsx`
- Create: `packages/app/src/features/projects/recent-projects.tsx`
- Create: `packages/app/src/routes.tsx`
- Modify: `packages/app/src/app.tsx`

**Step 1: Write failing controller tests**

Use an injected fake `DesktopBridge` and fake SDK factory. Cover:

```ts
it("persists a project only after project.current succeeds", async () => {
  sdk.project.current.mockResolvedValue({ data: { id: "p1", worktree: "C:\\work\\demo" } })
  const project = await controller.openProject("C:\\work\\demo")
  expect(project.id).toBe("p1")
  expect(bridge.saveRecentProjects).toHaveBeenCalledOnce()
})

it("creates the directory before asking the backend to initialize git", async () => {
  await controller.createProject({ parent: "C:\\work", name: "demo", initGit: true })
  expect(callOrder()).toEqual(["createProjectDirectory", "project.current", "project.initGit", "session.create"])
})

it("does not persist a failed project open", async () => {
  sdk.project.current.mockRejectedValue(new Error("not a project"))
  await expect(controller.openProject("C:\\bad")).rejects.toThrow("not a project")
  expect(bridge.saveRecentProjects).not.toHaveBeenCalled()
})
```

**Step 2: Run tests and verify failure**

Run: `bun run --cwd packages/app test -- src/features/projects/project-controller.test.ts`

Expected: FAIL because the controller does not exist.

**Step 3: Implement the project controller through SDK calls only**

```ts
async function openProject(directory: string) {
  const client = clientFor(directory)
  const result = await client.project.current({ directory }, { throwOnError: true })
  if (!result.data) throw new Error("项目后端未返回项目信息")
  await recents.touch(directory)
  return { directory, info: result.data, client }
}

async function createProject(input: { parent: string; name: string; initGit: boolean }) {
  const directory = await bridge.createProjectDirectory(input.parent, input.name)
  const opened = await openProject(directory)
  if (input.initGit) {
    await opened.client.project.initGit({ directory }, { throwOnError: true })
  }
  const session = await opened.client.session.create(
    { directory, multiAgent: false, title: "New session" },
    { throwOnError: true },
  )
  if (!session.data) throw new Error("创建 Session 失败")
  return { ...opened, session: session.data }
}
```

If Git initialization fails, keep the created/opened project and show an inline retry for Git; do not delete the directory.

**Step 4: Build the onboarding UI**

Use `HashRouter` with `/` for welcome and `/session/:sessionID` for the workspace. The welcome page has exactly two primary actions: “打开现有目录” and “新建项目”. The create dialog contains labeled parent directory, project name, and “初始化 Git” checkbox. Preserve all inputs after errors and focus the first invalid field.

Recent projects show at most ten paths. Missing directories remain visible with an “不可用” label and a remove action; they are not silently deleted.

**Step 5: Verify component behavior**

Add component tests for keyboard-only create/open, inline errors with `role="alert"`, cancel returning focus, and successful navigation to the created Session.

Run:

```powershell
cd packages/app
bun run test -- src/features/projects
bun run typecheck
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add packages/app/src/features/projects packages/app/src/routes.tsx packages/app/src/app.tsx
git commit -m "feat(gui): add project onboarding"
```

### Task 9: Implement root Session listing and management

**Files:**

- Create: `packages/app/src/features/sessions/session-api.ts`
- Create: `packages/app/src/features/sessions/session-api.test.ts`
- Create: `packages/app/src/features/sessions/session-list.tsx`
- Create: `packages/app/src/features/sessions/session-list.test.tsx`
- Create: `packages/app/src/features/sessions/session-list-item.tsx`
- Create: `packages/app/src/features/sessions/session-actions.tsx`
- Create: `packages/app/src/features/sessions/session-empty.tsx`
- Create: `packages/app/src/layout/workspace-layout.tsx`
- Modify: `packages/jyycode/src/server/routes/instance/httpapi/groups/session.ts:25`
- Modify: `packages/jyycode/src/server/routes/instance/httpapi/handlers/session.ts:58`
- Modify: `packages/jyycode/test/server/httpapi-session.test.ts`
- Modify: `packages/sdk/js/src/v2/gen/sdk.gen.ts` (generated)
- Modify: `packages/sdk/js/src/v2/gen/types.gen.ts` (generated)
- Modify: `packages/app/src/routes.tsx`

**Step 1: Write failing API tests**

Verify the exact shared-backend calls:

```ts
it("lists only current-project root sessions", async () => {
  await sessionApi.list(false)
  expect(client.session.list).toHaveBeenCalledWith(
    { directory, scope: "project", roots: true },
    { throwOnError: true },
  )
})

it("forces single-Agent mode when creating a session", async () => {
  await sessionApi.create({ title: "New session", agent: "build", model })
  expect(client.session.create).toHaveBeenCalledWith(
    { directory, title: "New session", agent: "build", model, multiAgent: false },
    { throwOnError: true },
  )
})

it("archives through session.update", async () => {
  vi.setSystemTime(1234)
  await sessionApi.archive("ses_1")
  expect(client.session.update).toHaveBeenCalledWith(
    { directory, sessionID: "ses_1", time: { archived: 1234 } },
    { throwOnError: true },
  )
})
```

**Step 2: Run and verify failure**

Run: `bun run --cwd packages/app test -- src/features/sessions`

Expected: FAIL because the feature is missing.

**Step 3: Extend the shared typed Session list with the existing archive filter**

The current `Session.Service.list` already supports `archived`, but the typed `/session` HttpApi query does not expose it. Add:

```ts
// groups/session.ts ListQuery
archived: Schema.optional(QueryBoolean),

// handlers/session.ts session.list input
archived: ctx.query.archived,
```

Add an HttpApi test that creates one active and one archived root, then proves `/session?roots=true` returns only active and `/session?roots=true&archived=true` returns the archived root. Regenerate the SDK rather than hand-editing generated files:

```powershell
cd packages/sdk/js
bun run build
```

Expected: the generated `client.session.list` parameters include `archived?: boolean | "true" | "false"`.

**Step 4: Implement Session queries and mutations**

- Active sessions: `session.list({ directory, scope: "project", roots: true })`.
- Archived sessions: `session.list({ directory, scope: "project", roots: true, archived: true })`.
- Status: `session.status({ directory })`.
- Rename/archive/delete: `session.update` or `session.delete` with `throwOnError: true`.
- After a mutation succeeds, invalidate active/archived list keys. Do not remove a Session optimistically before delete succeeds.

Sort roots by `time.updated` descending and filter any unexpected `parentID` defensively.

**Step 5: Build the 280px navigation rail**

The left rail contains project switcher, new Session button, Active/Archived segmented filter, Session list, and backend connection status. Each row exposes title, relative update time, status text/icon, and a keyboard-accessible actions menu.

Delete opens a confirmation dialog naming the Session. After delete, navigate to the next active Session; if none exists, render `SessionEmpty` with a new-session action.

**Step 6: Add interaction tests**

Cover:

- list sorting;
- active item semantics (`aria-current="page"`);
- rename inline validation;
- archive only after server success;
- delete cancel and confirm;
- narrow-window rail collapse with a labeled toggle.

**Step 7: Verify**

Run:

```powershell
cd packages/app
bun run test -- src/features/sessions
bun run typecheck
cd ../jyycode
bun test test/server/httpapi-session.test.ts --timeout 30000
```

Expected: PASS.

**Step 8: Commit**

```powershell
git add packages/app/src/features/sessions packages/app/src/layout packages/app/src/routes.tsx packages/jyycode/src/server/routes/instance/httpapi/groups/session.ts packages/jyycode/src/server/routes/instance/httpapi/handlers/session.ts packages/jyycode/test/server/httpapi-session.test.ts packages/sdk/js/src/v2/gen
git commit -m "feat(gui): add Session management"
```

### Task 10: Build deterministic conversation state and streaming message rendering

**Files:**

- Create: `packages/app/src/features/conversation/conversation-state.ts`
- Create: `packages/app/src/features/conversation/conversation-state.test.ts`
- Create: `packages/app/src/features/conversation/conversation-query.ts`
- Create: `packages/app/src/features/conversation/message-timeline.tsx`
- Create: `packages/app/src/features/conversation/message-part.tsx`
- Create: `packages/app/src/features/conversation/text-part.tsx`
- Create: `packages/app/src/features/conversation/reasoning-part.tsx`
- Create: `packages/app/src/features/conversation/tool-call-card.tsx`
- Create: `packages/app/src/features/conversation/markdown.ts`
- Create: `packages/app/src/features/conversation/markdown.test.ts`
- Modify: `packages/app/src/data/event-bridge.ts`

**Step 1: Write failing reducer tests**

Cover these cases with real SDK event shapes:

```ts
it("appends a delta exactly once", () => {
  const once = applyConversationEvent(snapshot, delta("hello", "evt_1"))
  const twice = applyConversationEvent(once, delta("hello", "evt_1"))
  expect(textOf(twice, "part_1")).toBe("hello")
})

it("inserts messages and parts in ID order", () => {
  const next = applyConversationEvents(emptySnapshot(), [partEvent, messageEvent])
  expect(next.messages[0]?.info.id).toBe("msg_1")
  expect(next.messages[0]?.parts[0]?.id).toBe("part_1")
})

it("requests a refetch when a delta has no base part", () => {
  expect(applyConversationEvent(emptySnapshot(), delta("x", "evt_2")).needsRefetch).toBe(true)
})
```

Store a bounded set of processed event IDs per active Session so reconnect replays do not duplicate deltas.

**Step 2: Run and verify failure**

Run: `bun run --cwd packages/app test -- src/features/conversation/conversation-state.test.ts`

Expected: FAIL because the reducer does not exist.

**Step 3: Implement snapshot loading and pure event application**

Load `session.messages({ directory, sessionID, limit: 100 })`. Keep the SDK's `MessageV2.WithParts[]` shape instead of inventing a second message domain model. Apply:

- `message.updated` by binary-searching message ID;
- `message.removed` by ID;
- `message.part.updated` by message/part ID;
- `message.part.delta` only to a present string field;
- `message.part.removed` by ID.

If a target is absent or an event field is not a string, return `needsRefetch: true` and leave the snapshot unchanged.

**Step 4: Sanitize Markdown**

```ts
export function renderMarkdown(source: string) {
  const html = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "srcset"],
  })
}
```

Tests must prove scripts, inline handlers, `javascript:` URLs, iframes, and forms are removed. External links receive `rel="noreferrer noopener"` and open through a controlled opener; phase 1 may render them as inert if opener permission is not added.

**Step 5: Implement the timeline and Part renderers**

- User messages use a subtle surface container.
- Assistant messages flow directly in the content column.
- Text Parts render sanitized Markdown.
- Reasoning Parts are collapsed by default with an explicit button and `aria-expanded`.
- Tool Parts show tool name, pending/running/completed/error text, duration when available, and a collapsible monospace payload. Never render raw HTML from tool output.
- Unknown Part types render a compact “Unsupported content” row in development and remain non-fatal in production.

Auto-scroll only when the user is already within 80px of the bottom. Otherwise show a “新消息” button; never steal scroll position while the user reads history.

**Step 6: Verify**

Run:

```powershell
cd packages/app
bun run test -- src/features/conversation
bun run typecheck
```

Expected: PASS, including duplicate delta and XSS tests.

**Step 7: Commit**

```powershell
git add packages/app/src/features/conversation packages/app/src/data/event-bridge.ts
git commit -m "feat(gui): render streaming conversations"
```

### Task 11: Add Agent/model selection and the Composer send/stop/retry loop

**Files:**

- Create: `packages/app/src/features/composer/model-catalog.ts`
- Create: `packages/app/src/features/composer/model-catalog.test.ts`
- Create: `packages/app/src/features/composer/composer-controller.ts`
- Create: `packages/app/src/features/composer/composer-controller.test.ts`
- Create: `packages/app/src/features/composer/composer.tsx`
- Create: `packages/app/src/features/composer/agent-select.tsx`
- Create: `packages/app/src/features/composer/model-select.tsx`
- Create: `packages/app/src/features/composer/provider-empty.tsx`
- Modify: `packages/app/src/layout/workspace-layout.tsx`

**Step 1: Write failing controller tests**

```ts
it("submits exactly one async single-Agent prompt", async () => {
  const promise = controller.send("hello")
  controller.send("hello")
  await promise
  expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(client.session.promptAsync).toHaveBeenCalledWith(
    {
      directory,
      sessionID,
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      agentCluster: { enabled: false },
      parts: [{ type: "text", text: "hello" }],
    },
    { throwOnError: true },
  )
})

it("keeps the draft when submission fails", async () => {
  client.session.promptAsync.mockRejectedValue(new Error("offline"))
  await expect(controller.send("keep me")).rejects.toThrow("offline")
  expect(controller.draft()).toBe("keep me")
})

it("stops a running session through abort", async () => {
  await controller.stop()
  expect(client.session.abort).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
})
```

**Step 2: Load available Agents and models**

In parallel call the same endpoints used by the TUI:

- `client.app.agents({ directory })`
- `client.config.providers({ directory })`
- `client.provider.list({ directory })`
- `client.config.get({ directory })`

Choose the configured/default model first, then the first connected model. Choose the default primary Agent, falling back to `build`. Persist only provider/model IDs and Agent name as desktop preference; revalidate them against every fresh catalog.

If no Provider/model is usable, render `ProviderEmpty` with the global config path returned by the backend and an explanation. Provider OAuth/configuration UI remains out of phase 1; do not silently select an unavailable model.

**Step 3: Run and verify failure**

Run: `bun run --cwd packages/app test -- src/features/composer`

Expected: FAIL before implementation.

**Step 4: Implement Composer behavior**

- `Enter` sends; `Shift+Enter` inserts a newline.
- Trim only for the empty check; send the original text.
- Lock concurrent send calls with an in-flight promise/boolean.
- Clear the draft only after `promptAsync` returns success.
- When `session.status.type !== "idle"`, replace Send with Stop.
- Stop calls `session.abort`; an aborted error event is informational, not a red failure.
- Retry restores the last failed draft and calls the same send path; it does not create a local assistant message.
- Set `agentCluster: { enabled: false }` explicitly on every phase-1 Prompt.

**Step 5: Add accessibility and IME tests**

Test labeled selectors, Enter vs Shift+Enter, composition events not submitting early, duplicate Enter protection, visible busy state, and `aria-live="polite"` generation status.

**Step 6: Verify**

Run:

```powershell
cd packages/app
bun run test -- src/features/composer
bun run typecheck
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add packages/app/src/features/composer packages/app/src/layout/workspace-layout.tsx
git commit -m "feat(gui): add single-Agent Composer loop"
```

### Task 12: Complete permission and Agent-question interactions

**Files:**

- Create: `packages/app/src/features/requests/request-query.ts`
- Create: `packages/app/src/features/requests/permission-bar.tsx`
- Create: `packages/app/src/features/requests/permission-bar.test.tsx`
- Create: `packages/app/src/features/requests/question-panel.tsx`
- Create: `packages/app/src/features/requests/question-panel.test.tsx`
- Modify: `packages/app/src/data/event-bridge.ts`
- Modify: `packages/app/src/layout/workspace-layout.tsx`

**Step 1: Write failing permission tests**

```tsx
it("keeps a permission visible until the server confirms it", async () => {
  renderPermission(request)
  await user.click(screen.getByRole("button", { name: "仅本次允许" }))
  expect(client.permission.reply).toHaveBeenCalledWith(
    { directory, requestID: request.id, reply: "once" },
    { throwOnError: true },
  )
  expect(screen.getByRole("region", { name: "权限请求" })).toBeVisible()
  emit(permissionReplied(request.id))
  expect(screen.queryByRole("region", { name: "权限请求" })).not.toBeInTheDocument()
})
```

Also test reject with an optional reason and “always” requiring a confirmation step that displays the backend-provided patterns.

**Step 2: Write failing question tests**

Cover single choice, multi-select, custom answer, multiple question tabs, submit, and reject. Use the SDK's `QuestionAnswer[]` shape exactly.

**Step 3: Run and verify failure**

Run: `bun run --cwd packages/app test -- src/features/requests`

Expected: FAIL because the request UI does not exist.

**Step 4: Implement request snapshots and SSE updates**

Initial queries:

```ts
client.permission.list({ directory }, { throwOnError: true })
client.question.list({ directory }, { throwOnError: true })
```

Filter requests to the active root Session. Apply asked/replied/rejected events in `EventBridge`. Keep a submitted card visible and disabled until the corresponding server event removes it; on request failure, re-enable it with an inline error.

**Step 5: Implement the fixed request area**

Render the highest-priority request directly above Composer. Permissions take precedence over questions because the Agent cannot continue without them. Announce new requests through a polite live region, move focus only when the user invokes “处理请求”, and provide full keyboard operation.

**Step 6: Verify**

Run:

```powershell
cd packages/app
bun run test -- src/features/requests
bun run typecheck
```

Expected: PASS.

**Step 7: Commit**

```powershell
git add packages/app/src/features/requests packages/app/src/data/event-bridge.ts packages/app/src/layout/workspace-layout.tsx
git commit -m "feat(gui): handle Agent permissions and questions"
```

### Task 13: Add backend failure recovery and persisted resume

**Files:**

- Create: `packages/app/src/features/lifecycle/lifecycle-controller.ts`
- Create: `packages/app/src/features/lifecycle/lifecycle-controller.test.ts`
- Create: `packages/app/src/features/lifecycle/backend-unavailable.tsx`
- Create: `packages/app/src/features/lifecycle/reconnect-banner.tsx`
- Create: `packages/app/src/features/lifecycle/startup-loading.tsx`
- Modify: `packages/app/src/platform/types.ts`
- Modify: `packages/app/src/platform/tauri.ts`
- Modify: `packages/app/src/app.tsx`

**Step 1: Write failing resume tests**

```ts
it("restores a valid last project and Session", async () => {
  bridge.loadLastLocation.mockResolvedValue({ project: directory, sessionID: "ses_1" })
  sdk.project.current.mockResolvedValue({ data: project })
  sdk.session.get.mockResolvedValue({ data: session })
  await controller.start()
  expect(controller.route()).toBe("/session/ses_1")
})

it("falls back to the project empty state when the Session was deleted", async () => {
  sdk.session.get.mockRejectedValue(notFound)
  await controller.start()
  expect(controller.route()).toBe("/")
  expect(controller.project()?.directory).toBe(directory)
})

it("does not loop forever after a second backend failure", async () => {
  bridge.restartBackend.mockRejectedValue(new Error("still broken"))
  await controller.recover()
  await controller.recover()
  expect(bridge.restartBackend).toHaveBeenCalledTimes(1)
  expect(controller.phase()).toBe("failed")
})
```

**Step 2: Run and verify failure**

Run: `bun run --cwd packages/app test -- src/features/lifecycle`

Expected: FAIL before implementation.

**Step 3: Implement startup state transitions**

Use explicit phases: `booting -> backendReady -> projectLoading -> ready`, with terminal `failed`. Load bootstrap first, then last project, then validate last Session. Never render the workspace with a missing SDK/project context.

Persist location only after project/session validation. Keep unsent Composer text in memory across a sidecar restart but not across a full application restart.

**Step 4: Implement recovery UI**

`BackendUnavailable` shows a concise reason, log location if supplied by Rust, “重新启动后端”, and “返回项目选择”. It must not print environment variables or the Basic auth header.

`ReconnectBanner` is low prominence while retrying. Disable new Prompt submission during a disconnected SSE state but keep all loaded messages readable. On reconnect, invalidate snapshots before hiding the banner.

**Step 5: Verify**

Run:

```powershell
cd packages/app
bun run test -- src/features/lifecycle
bun run typecheck
```

Expected: PASS with fake timers and no leaked retry timers.

**Step 6: Commit**

```powershell
git add packages/app/src/features/lifecycle packages/app/src/platform packages/app/src/app.tsx
git commit -m "feat(gui): restore desktop state and recover backend"
```

### Task 14: Add cross-layer integration and accessibility regression tests

**Files:**

- Create: `packages/app/src/test/fake-desktop.ts`
- Create: `packages/app/src/test/fake-jyycode.ts`
- Create: `packages/app/src/app.integration.test.tsx`
- Create: `packages/app/src/accessibility.test.tsx`
- Create: `packages/jyycode/test/server/desktop-contract.test.ts`
- Modify: `packages/app/vite.config.ts`

**Step 1: Write the failing desktop contract test**

Use a temporary git directory and a real test server. Verify in one test:

1. authenticated health request succeeds;
2. `project.current` accepts the Tauri directory context;
3. `session.create` with `multiAgent: false` succeeds;
4. `session.promptAsync` accepts a single-Agent prompt;
5. the SSE stream delivers the created message/Part events;
6. a fresh SDK client can reload the Session messages.

Do not mock repository services in this test.

**Step 2: Write the failing GUI journey test**

With a fake platform bridge and a fake SDK transport, drive the rendered app entirely through accessible UI:

```text
Welcome -> create project -> first Session -> choose Agent/model -> send prompt
-> receive text/tool deltas -> answer permission -> stop -> reload app -> restore Session
```

Assert no Multi-Agent control appears anywhere.

**Step 3: Add accessibility regression assertions**

At minimum verify:

- one `<main>` landmark;
- labeled project, Session, Agent, model, and Composer controls;
- no icon-only button without an accessible name;
- focus returns after dialogs;
- keyboard can create a project, select a Session, send, stop, and answer requests;
- async errors use `role="alert"` and status changes use a polite live region;
- reduced motion disables nonessential transitions.

**Step 4: Run tests and verify failure, then fill only missing seams**

Run:

```powershell
cd packages/jyycode
bun test test/server/desktop-contract.test.ts --timeout 30000
cd ../app
bun run test -- src/app.integration.test.tsx src/accessibility.test.tsx
```

Expected before fixes: FAIL at the first missing integration seam. Implement only wiring/contract fixes; do not expand phase-1 scope.

**Step 5: Run the complete relevant suite**

```powershell
bun turbo typecheck
cd packages/jyycode
bun test test/cli/serve/serve-process.test.ts test/server/desktop-contract.test.ts test/server/httpapi-session.test.ts test/server/httpapi-event.test.ts test/server/auth.test.ts --timeout 60000
cd ../app
bun run test
bun run build
cd ../desktop/src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

Expected: all PASS.

**Step 6: Commit**

```powershell
git add packages/app/src/test packages/app/src/app.integration.test.tsx packages/app/src/accessibility.test.tsx packages/app/vite.config.ts packages/jyycode/test/server/desktop-contract.test.ts
git commit -m "test(desktop): cover shared-backend GUI journey"
```

### Task 15: Package, smoke-test, and document the Windows release

**Files:**

- Create: `.github/workflows/desktop-windows.yml`
- Create: `packages/desktop/script/smoke-windows.ps1`
- Create: `packages/desktop/README.md`
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Modify: `RELEASE.md`

**Step 1: Write the smoke script before the release workflow**

The PowerShell script must:

1. locate the built raw desktop exe and both installer artifacts;
2. assert all exist and are non-empty;
3. launch the raw exe with `Start-Process -PassThru` and no visible console window;
4. wait up to 20 seconds for one child `jyycode-sidecar` process;
5. fail if zero or more than one sidecar exists;
6. close the desktop process;
7. wait up to 10 seconds and fail if its sidecar remains;
8. print artifact paths and sizes, but no environment or process command line.

Use process IDs/parent relationships through CIM; do not kill unrelated JYYCode CLI processes by name.

**Step 2: Run the smoke script and verify it initially fails**

Run:

```powershell
pwsh packages/desktop/script/smoke-windows.ps1
```

Expected: FAIL because release artifacts do not exist yet.

**Step 3: Configure deterministic Windows builds**

- Stage the x64 sidecar before `tauri build`.
- Build NSIS and MSI on `windows-2022`.
- Keep `downloadBootstrapper` for WebView2 in phase 1; document that the installer requires network only when WebView2 is absent.
- Copy the raw `target/x86_64-pc-windows-msvc/release/jyycode-desktop.exe` as the portable artifact.
- Generate and upload SHA-256 checksums.
- Do not enable auto-update or code-signing with placeholder credentials.
- Add an explicit future gate for Windows signing secrets before public stable distribution.

The workflow sequence is:

```yaml
- uses: actions/checkout@v4
- uses: oven-sh/setup-bun@v2
  with: { bun-version: 1.3.14 }
- uses: dtolnay/rust-toolchain@stable
  with: { targets: x86_64-pc-windows-msvc }
- run: bun install --frozen-lockfile
- run: bun turbo typecheck
- run: bun run --cwd packages/app test
- run: cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
- run: bun run --cwd packages/desktop stage:sidecar
- run: bun run --cwd packages/app build
- run: bun run --cwd packages/desktop build -- --target x86_64-pc-windows-msvc
- shell: pwsh
  run: ./packages/desktop/script/smoke-windows.ps1
```

Pin third-party actions to commit SHAs when implementing the workflow, following the repository's existing CI policy.

**Step 4: Document development and release commands**

`packages/desktop/README.md` must include prerequisites, architecture boundary, `bun run dev`, test commands, installer/portable output locations, WebView2 behavior, log location, and the fact that Provider configuration is reused from the JYYCode backend in phase 1.

Add concise desktop sections to both root READMEs without replacing existing CLI/TUI documentation.

**Step 5: Build and run final verification**

Run:

```powershell
bun install --frozen-lockfile
bun turbo typecheck
bun run --cwd packages/app test
bun run --cwd packages/app build
bun run --cwd packages/desktop test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
bun run --cwd packages/desktop stage:sidecar
bun run --cwd packages/desktop build -- --target x86_64-pc-windows-msvc
pwsh packages/desktop/script/smoke-windows.ps1
git diff --check
```

Expected: all commands PASS; NSIS, MSI, raw portable exe, and checksums exist; closing the GUI removes its sidecar.

**Step 6: Manual acceptance pass**

On a clean Windows 10/11 VM:

1. install with no preinstalled Bun/Node/JYYCode;
2. create a project with Git;
3. open an existing project;
4. create, rename, archive, and delete Sessions;
5. complete a multi-turn single-Agent conversation with a tool permission and an Agent question;
6. stop a response and retry a failed send;
7. restart the app and confirm project/Session/messages return;
8. open the same directory in TUI and confirm the same Session/messages are visible;
9. verify 100%, 125%, and 150% DPI at 1024x720 and 1440x900;
10. verify no sidecar remains after exit.

**Step 7: Commit**

```powershell
git add .github/workflows/desktop-windows.yml packages/desktop README.md README-zh.md RELEASE.md
git commit -m "build(desktop): package Windows application"
```

## Final completion gate

Phase 1 is complete only when all of the following are true:

- No GUI code imports backend internals or opens SQLite directly.
- TUI and GUI observe the same project, Session, and message state.
- Every Prompt explicitly disables Agent Cluster.
- Sidecar listens only on authenticated loopback and is owned by the Rust process supervisor.
- Project filesystem mutation is limited to the validated create-directory command; Git initialization uses the shared API.
- SSE reconnect produces no duplicate delta text.
- Permission and question requests remain visible until server confirmation.
- Core UI is keyboard-operable and meets the approved contrast checks.
- Windows installer, MSI, and portable artifacts pass the clean-VM smoke test.
- `git status --short` contains no unexpected generated files.

## Execution notes

- Work through tasks sequentially; Tasks 8–13 depend on the contracts established by Tasks 1–7.
- Keep each task's commit independent and green.
- If the generated SDK lacks a typed field needed by an existing backend route, update the HttpApi schema and regenerate the SDK; do not add one-off raw requests in the GUI.
- If a Tauri API has changed from the pinned version, consult the official Tauri 2 documentation and update the plan/lockfile together rather than weakening capabilities.
- Stop and review after Tasks 5, 10, and 14 because those are the security, event-consistency, and end-to-end checkpoints.
