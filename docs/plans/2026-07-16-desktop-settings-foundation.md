# Desktop Settings Foundation Implementation Plan

> Follow-up implementation and current acceptance status: [Desktop Settings Phase Two acceptance](../desktop-settings-phase-two-acceptance.md).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-screen JYYCode Settings center reachable from Home and the project workspace, implement the safe simple settings now, and visibly reserve the complex requested settings as honest placeholders.

**Architecture:** Add a standalone /settings/:section? route wrapped in the existing global management provider, but not the Home/Skill/MCP rail. Both entry points pass a sanitized internal return route so the page returns to Home or the same project Session. Desktop-only preferences use the existing Tauri store; global default permission and Shell use typed backend configuration APIs.

**Tech Stack:** SolidJS, @solidjs/router, TanStack Solid Query, generated JYYCode SDK v2, Effect HTTP API, Tauri 2, tauri-plugin-store, Rust, Vitest, Bun test, Cargo test.

---

## Product decisions and acceptance criteria

### Settings layout

Settings is a full-screen route with a top-left 返回 button and its own left navigation:

- 常规
- 权限与安全
- 高级

It does not render within the narrow management rail. This keeps the experience identical from Home and the project workspace.

### First-release working settings

| Section | Setting | Persistence / behavior |
| --- | --- | --- |
| 常规 | 启动时：恢复上次项目 / 显示 Home | desktop.json; Home skips last-location restoration. |
| 常规 | 外观：深色 / 浅色 | desktop.json; semantic tokens apply to the document root and survive restart. |
| 权限与安全 | 新 Session 默认权限：自动 / 每次询问 / 完全访问 | Global JYYCode configuration via a narrow API that supports safely returning to automatic mode. |
| 高级 | 默认 Shell | Global JYYCode config shell field; system default is represented by an empty value. |
| 高级 | 打开全局配置文件 | A validated Tauri command reveals the exact backend-provided jyycode config file. |

### First-release placeholders

Every deferred item uses a disabled control, an 即将推出 badge, and one sentence explaining why it cannot be enabled. It must not persist any value.

| Requested setting | Display text | Deferral reason |
| --- | --- | --- |
| 语言 | 简体中文 · 即将推出 | A true language control requires centralized message catalogs. |
| 液态玻璃 | Apple 风格液态玻璃 · 即将推出 | It needs a complete visual system and Windows/WebView validation, not isolated backdrop CSS. |
| Windows 通知 | 回复完成、等待权限、Agent 提问 · 即将推出 | Native notification capability and focused/background event rules are not present. |
| 自动更新 | 自动安装 / 仅提醒 / 关闭 · 即将推出 | Desktop bundles set createUpdaterArtifacts to false and have no signed update endpoint. |
| 上下文压缩参数 | 高级参数 · 即将推出 | Some compaction mechanisms remain stubs; safe product defaults and validation are required. |
| 记忆管理 | 查看、清理和导出记忆 · 即将推出 | Memory exists in the backend, but no safe typed management API exists for the desktop UI. |

Do not add Profile, account, connector, marketplace, or project-scoped settings. Do not duplicate Skill or MCP CRUD inside Settings.

### Navigation and safety rules

- The Home bottom rail uses a Settings gear link; workspace uses an icon-only Settings button adjacent to the backend connection status.
- Use returnTo only for /, /workspace, or /session/<encoded-id>. Reject every other value and fall back to /.
- Stored theme is dark or light only; dark is default. Liquid glass is not a partially working third theme.
- The permission control changes new Sessions only. Existing Sessions retain their per-Session permission selection.
- If global permission is fine-grained, show 自定义配置 and do not overwrite it without a confirmation dialog.
- Config revealing must use a fixed native executable plus argument array, never a shell string.

### Acceptance criteria

1. Both red-box locations in the supplied screenshots expose a keyboard-accessible Settings control.
2. Both controls open the same full-screen Settings page; 返回 restores the calling Home or Session route.
3. Startup, theme, default permission, and Shell settings remain effective after restart/new Session where applicable.
4. The global configuration action cannot launch arbitrary shell commands.
5. Every deferred requested item is visible, disabled, labelled 即将推出, and cannot falsely save state.
6. Settings remains readable at 960×640 and 1280×820 in dark and light themes.

## Task 1: Add desktop settings preferences and persistence

**Files:**
- Create: packages/app/src/features/settings/settings-preferences.ts
- Create: packages/app/src/features/settings/settings-preferences.test.ts
- Modify: packages/app/src/platform/types.ts
- Modify: packages/app/src/platform/tauri.ts
- Modify: packages/app/src/platform/browser.ts
- Modify: packages/app/src/test/fake-desktop.ts
- Test: packages/app/src/platform/browser.test.ts (create if absent)

**Step 1: Write the failing parser and bridge tests**

~~~ts
expect(parseDesktopSettings(undefined)).toEqual({ startup: "restore", theme: "dark" })
expect(parseDesktopSettings({ startup: "home", theme: "light" })).toEqual({ startup: "home", theme: "light" })
expect(parseDesktopSettings({ startup: "bad", theme: "liquid" })).toEqual({ startup: "restore", theme: "dark" })
~~~

Test browser persistence, malformed data recovery, Tauri bridge round-trip semantics, and copies returned by the fake bridge.

**Step 2: Run test to verify failure**

Run: bun run --cwd packages/app test -- src/features/settings/settings-preferences.test.ts

Expected: FAIL because settings preference types and bridge methods do not exist.

**Step 3: Implement the minimal preferences contract**

Create:

~~~ts
export type StartupPreference = "restore" | "home"
export type ColorTheme = "dark" | "light"

export type DesktopSettings = {
  startup: StartupPreference
  theme: ColorTheme
}

export const defaultDesktopSettings: DesktopSettings = { startup: "restore", theme: "dark" }
~~~

Add parseDesktopSettings with field-by-field validation. Extend DesktopBridge with loadSettings and saveSettings. Persist under settings in the existing desktop.json Tauri Store and jyycode.desktop.settings in browser storage. Update the fake desktop bridge with settings input and a settings() read helper.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/settings/settings-preferences.test.ts src/platform/browser.test.ts

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings/settings-preferences.ts packages/app/src/features/settings/settings-preferences.test.ts packages/app/src/platform/types.ts packages/app/src/platform/tauri.ts packages/app/src/platform/browser.ts packages/app/src/platform/browser.test.ts packages/app/src/test/fake-desktop.ts
git commit -m "feat(desktop): persist settings preferences"
~~~

## Task 2: Apply startup behavior and dark/light themes

**Files:**
- Create: packages/app/src/features/settings/theme.ts
- Create: packages/app/src/features/settings/theme.test.ts
- Modify: packages/app/src/features/lifecycle/lifecycle-controller.ts
- Modify: packages/app/src/features/lifecycle/lifecycle-controller.test.ts
- Modify: packages/app/src/app.tsx
- Modify: packages/app/src/styles/tokens.css
- Modify: packages/app/src/styles/theme.test.ts

**Step 1: Write failing lifecycle and theme tests**

~~~ts
await controller.start()
expect(bridge.loadLastLocation).not.toHaveBeenCalled() // settings.startup === "home"
expect(controller.route()).toBe("/")

applyTheme("light", document.documentElement)
expect(document.documentElement.dataset.theme).toBe("light")
~~~

Also assert that every semantic token used by the UI is declared in both themes and that color-scheme matches the selected theme.

**Step 2: Run test to verify failure**

Run: bun run --cwd packages/app test -- src/features/lifecycle/lifecycle-controller.test.ts src/features/settings/theme.test.ts src/styles/theme.test.ts

Expected: FAIL because the lifecycle always restores the last location and no light theme exists.

**Step 3: Implement the minimal behavior**

- After bootstrap and before loadLastLocation, load desktop settings. For startup home, set route to /, mark ready, and leave last location untouched.
- Create pure applyTheme(theme, root = document.documentElement), which sets root.dataset.theme.
- In DesktopApplication, load/apply the stored theme before mounting normal routes; updates apply optimistically and roll back if persistence fails.
- Move current root values to html[data-theme="dark"]. Add html[data-theme="light"] values for every semantic token: background, panel, surface, text, accent/ink, borders, danger/success, overlay, focus ring, and shadow.
- Do not use hard-coded component colors to make light theme work.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/lifecycle/lifecycle-controller.test.ts src/features/settings/theme.test.ts src/styles/theme.test.ts

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings/theme.ts packages/app/src/features/settings/theme.test.ts packages/app/src/features/lifecycle/lifecycle-controller.ts packages/app/src/features/lifecycle/lifecycle-controller.test.ts packages/app/src/app.tsx packages/app/src/styles/tokens.css packages/app/src/styles/theme.test.ts
git commit -m "feat(desktop): honor startup and theme preferences"
~~~

## Task 3: Expose default permission policy through a typed API

**Files:**
- Modify: packages/jyycode/src/server/routes/instance/httpapi/groups/global.ts
- Modify: packages/jyycode/src/server/routes/instance/httpapi/handlers/global.ts
- Create: packages/jyycode/test/server/global-default-permission.test.ts
- Modify: packages/sdk/openapi.json
- Modify: packages/sdk/js/src/v2/gen/types.gen.ts
- Modify: packages/sdk/js/src/v2/gen/sdk.gen.ts
- Modify: packages/app/src/test/fake-jyycode.ts

**Step 1: Write the failing server test**

Use a temporary global JSONC config with comments, unrelated settings, and a custom permission object.

~~~ts
await client.global.defaultPermission.update({ mode: "request" })
expect(await readGlobalConfig()).toContain('"*": "ask"')

await client.global.defaultPermission.update({ mode: "auto" })
expect((await client.global.config.get()).data?.permission).toBeUndefined()
~~~

Verify a fine-grained ruleset is reported as mode custom rather than guessed or overwritten.

**Step 2: Run test to verify failure**

Run: bun test packages/jyycode/test/server/global-default-permission.test.ts --timeout 30000

Expected: FAIL because this endpoint does not exist.

**Step 3: Implement the narrow API**

In the global HTTP group define a read mode union auto | request | full | custom and an update input that only accepts auto | request | full. Add GET and PUT endpoints at /global/default-permission.

In the handler:

- Map no permission field to auto.
- Map exactly { "*": "ask" } to request and exactly { "*": "allow" } to full.
- Report everything else as custom.
- For auto call Config.updateGlobalPath(["permission"], undefined), so deletion works in JSONC.
- For request/full call updateGlobalPath with { "*": "ask" } or { "*": "allow" }.
- Dispose active instances only after a changed value, using disposeAllInstancesAndEmitGlobalDisposed.

Regenerate OpenAPI and the v2 SDK using the repository’s existing API-generation workflow. Do not hand-edit generated formatting. Extend fake-jyycode with normalized GET/PUT behavior.

**Step 4: Run focused tests**

Run: bun test packages/jyycode/test/server/global-default-permission.test.ts --timeout 30000

Run: bun run --cwd packages/sdk/js typecheck

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/jyycode/src/server/routes/instance/httpapi/groups/global.ts packages/jyycode/src/server/routes/instance/httpapi/handlers/global.ts packages/jyycode/test/server/global-default-permission.test.ts packages/sdk/openapi.json packages/sdk/js/src/v2/gen/types.gen.ts packages/sdk/js/src/v2/gen/sdk.gen.ts packages/app/src/test/fake-jyycode.ts
git commit -m "feat(settings): expose default permission policy"
~~~

## Task 4: Build full-screen Settings routing and dual entry points

**Files:**
- Create: packages/app/src/features/settings/settings-route.tsx
- Create: packages/app/src/features/settings/settings-page.tsx
- Create: packages/app/src/features/settings/settings-page.test.tsx
- Create: packages/app/src/features/settings/settings-navigation.ts
- Create: packages/app/src/features/settings/settings-navigation.test.ts
- Create: packages/app/src/features/settings/settings.css
- Modify: packages/app/src/routes.tsx
- Modify: packages/app/src/features/management/management-shell.tsx
- Modify: packages/app/src/features/management/management-shell.css
- Modify: packages/app/src/features/management/management-shell.test.tsx
- Modify: packages/app/src/layout/workspace-layout.tsx
- Modify: packages/app/src/features/sessions/sessions.css
- Modify: packages/app/src/layout/workspace-layout.test.tsx

**Step 1: Write failing navigation tests**

~~~tsx
await user.click(screen.getByRole("link", { name: "设置" }))
expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible()
expect(screen.queryByRole("navigation", { name: "全局管理" })).not.toBeInTheDocument()
~~~

~~~ts
expect(sanitizeSettingsReturnTo("https://example.com")).toBe("/")
expect(sanitizeSettingsReturnTo("/session/ses_1")).toBe("/session/ses_1")
~~~

Render WorkspaceLayoutView with an active Session, click the icon button labelled 打开设置, and assert its destination includes that same Session path.

**Step 2: Run test to verify failure**

Run: bun run --cwd packages/app test -- src/features/settings/settings-navigation.test.ts src/features/settings/settings-page.test.tsx src/features/management/management-shell.test.tsx src/layout/workspace-layout.test.tsx

Expected: FAIL because Settings route and controls do not exist.

**Step 3: Implement routing and layout**

- Add lazy /settings and /settings/:section routes wrapped in ManagementProvider only, never ManagementShell.
- Add settingsHref(section, returnTo) and sanitizeSettingsReturnTo(value). Preserve the query while switching settings sections.
- Add a bottom-aligned gear link labelled 设置 below Home/Skill/MCP. It targets settingsHref("general", "/").
- Add a secondary icon button labelled 打开设置 beside the workspace backend connection footer. It targets the active Session path or /workspace.
- Settings has a back button, h1 设置, and links for 常规, 权限与安全, 高级. Back navigates only to sanitized returnTo, not raw browser history.
- At <=720px, collapse the local sidebar into a horizontal tab row; Settings content owns scrolling.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/settings/settings-navigation.test.ts src/features/settings/settings-page.test.tsx src/features/management/management-shell.test.tsx src/layout/workspace-layout.test.tsx

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings packages/app/src/routes.tsx packages/app/src/features/management/management-shell.tsx packages/app/src/features/management/management-shell.css packages/app/src/features/management/management-shell.test.tsx packages/app/src/layout/workspace-layout.tsx packages/app/src/features/sessions/sessions.css packages/app/src/layout/workspace-layout.test.tsx
git commit -m "feat(desktop): add full-screen settings navigation"
~~~

## Task 5: Implement General settings and placeholders

**Files:**
- Create: packages/app/src/features/settings/general-settings.tsx
- Create: packages/app/src/features/settings/general-settings.test.tsx
- Modify: packages/app/src/features/settings/settings-page.tsx
- Modify: packages/app/src/features/settings/settings.css

**Step 1: Write failing General-page tests**

~~~tsx
await user.click(screen.getByRole("radio", { name: "启动时显示 Home" }))
await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith({ startup: "home", theme: "dark" }))

await user.click(screen.getByRole("radio", { name: "浅色" }))
expect(document.documentElement.dataset.theme).toBe("light")
expect(screen.getByText("Apple 风格液态玻璃")).toBeVisible()
~~~

Assert language, liquid glass, and all three Windows notification controls are disabled and described as unavailable.

**Step 2: Run test to verify failure**

Run: bun run --cwd packages/app test -- src/features/settings/general-settings.test.tsx

Expected: FAIL because General settings do not exist.

**Step 3: Implement the agreed scope**

- Use accessible radio groups for startup preference and dark/light appearance.
- Apply theme optimistically; on store failure, restore previous DOM theme/value and show InlineError.
- Display language as disabled select 简体中文 + 即将推出.
- Display liquid glass as a disabled appearance card. Do not add partial backdrop-filter effects.
- Display a disabled Windows 通知 group containing 回复完成, 等待权限, Agent 提问 and state that native notification plumbing is pending.
- Reuse a ComingSoonSetting component for all placeholders so disabled semantics and badge wording cannot drift.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/settings/general-settings.test.tsx src/features/settings/theme.test.ts

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings/general-settings.tsx packages/app/src/features/settings/general-settings.test.tsx packages/app/src/features/settings/settings-page.tsx packages/app/src/features/settings/settings.css
git commit -m "feat(settings): add general preferences"
~~~

## Task 6: Implement default Session permission controls

**Files:**
- Create: packages/app/src/features/settings/default-permission.ts
- Create: packages/app/src/features/settings/default-permission.test.ts
- Create: packages/app/src/features/settings/security-settings.tsx
- Create: packages/app/src/features/settings/security-settings.test.tsx
- Modify: packages/app/src/features/settings/settings-page.tsx
- Modify: packages/app/src/features/settings/settings.css

**Step 1: Write failing mode and UI tests**

~~~ts
expect(displayDefaultPermission({ mode: "custom" })).toEqual({ label: "自定义配置", editable: false })
~~~

~~~tsx
await user.click(screen.getByRole("radio", { name: "每次询问" }))
expect(client.global.defaultPermission.update).toHaveBeenCalledWith({ mode: "request" }, { throwOnError: true })

await user.click(screen.getByRole("radio", { name: "完全访问" }))
expect(await screen.findByRole("dialog", { name: "替换自定义权限" })).toBeVisible()
~~~

Include mutation failure rollback and current-Session non-interference.

**Step 2: Run test to verify failure**

Run: bun run --cwd packages/app test -- src/features/settings/default-permission.test.ts src/features/settings/security-settings.test.tsx

Expected: FAIL because the component and SDK calls do not exist.

**Step 3: Implement safely**

- Query client.global.defaultPermission.get with TanStack Query.
- Render 自动, 每次询问, 完全访问 with short risk descriptions.
- For custom mode, render a read-only custom configuration card and an action to open the global config.
- Selecting a simple policy from custom opens Dialog confirmation that states custom rules are replaced.
- Save through the narrow endpoint, invalidate the permission query and keys.globalConfig, announce saving, and roll back on failure.
- State in the UI that it applies only to new Sessions.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/settings/default-permission.test.ts src/features/settings/security-settings.test.tsx

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings/default-permission.ts packages/app/src/features/settings/default-permission.test.ts packages/app/src/features/settings/security-settings.tsx packages/app/src/features/settings/security-settings.test.tsx packages/app/src/features/settings/settings-page.tsx packages/app/src/features/settings/settings.css
git commit -m "feat(settings): configure default session permissions"
~~~

## Task 7: Implement Advanced Shell/config opening and deferred cards

**Files:**
- Create: packages/app/src/features/settings/advanced-settings.tsx
- Create: packages/app/src/features/settings/advanced-settings.test.tsx
- Create: packages/app/src/features/settings/global-config-path.ts
- Create: packages/app/src/features/settings/global-config-path.test.ts
- Modify: packages/app/src/platform/types.ts
- Modify: packages/app/src/platform/tauri.ts
- Modify: packages/app/src/platform/browser.ts
- Modify: packages/app/src/test/fake-desktop.ts
- Modify: packages/desktop/src-tauri/src/project_path.rs
- Modify: packages/desktop/src-tauri/src/lib.rs
- Modify: packages/desktop/src-tauri/capabilities/main.json
- Modify: packages/app/src/features/settings/settings-page.tsx
- Modify: packages/app/src/features/settings/settings.css

**Step 1: Write failing path, UI, and Rust tests**

~~~ts
expect(globalConfigPath("C:\\Users\\dev\\.config\\jyycode")).toBe("C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc")
await user.selectOptions(screen.getByLabelText("默认 Shell"), "pwsh")
expect(client.global.config.update).toHaveBeenCalledWith({ config: { shell: "pwsh" } }, { throwOnError: true })
~~~

Add Rust tests for a helper accepting only an absolute path ending in jyycode.jsonc or jyycode.json. Verify the Explorer invocation uses a fixed executable and argument array.

**Step 2: Run tests to verify failure**

Run: bun run --cwd packages/app test -- src/features/settings/global-config-path.test.ts src/features/settings/advanced-settings.test.tsx

Run: cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml project_path::tests

Expected: FAIL because advanced controls and native command do not exist.

**Step 3: Implement working Advanced controls**

- Query client.global.config.get and client.path.get({ directory: management.directory }) in parallel. Derive the filename in one pure globalConfigPath helper.
- Render default Shell with a system-default empty option plus pwsh, powershell, cmd, bash. Preserve an unrecognized existing value as 当前值 rather than discarding it.
- Save with client.global.config.update({ config: { shell } }, { throwOnError: true }); shell empty relies on existing writableGlobal deletion behavior.
- Add DesktopBridge.revealConfigFile(path); browser bridge rejects it as desktop-only.
- Add Tauri reveal_config_file(path) in project_path.rs. Validate path/basename, launch explorer.exe using [/select,, path] without a shell, register it in lib.rs, and grant only the necessary capability.
- Display open-global-config as a secondary button; disable during path loading and expose native failures with InlineError.
- Render disabled shared ComingSoonSetting cards for 自动更新, 上下文压缩参数, and 记忆管理. Send no update, compaction, or memory mutation in this phase.

**Step 4: Run focused tests**

Run: bun run --cwd packages/app test -- src/features/settings/global-config-path.test.ts src/features/settings/advanced-settings.test.tsx

Run: cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml project_path::tests

Expected: PASS.

**Step 5: Commit**

~~~powershell
git add packages/app/src/features/settings/advanced-settings.tsx packages/app/src/features/settings/advanced-settings.test.tsx packages/app/src/features/settings/global-config-path.ts packages/app/src/features/settings/global-config-path.test.ts packages/app/src/platform/types.ts packages/app/src/platform/tauri.ts packages/app/src/platform/browser.ts packages/app/src/test/fake-desktop.ts packages/desktop/src-tauri/src/project_path.rs packages/desktop/src-tauri/src/lib.rs packages/desktop/src-tauri/capabilities/main.json packages/app/src/features/settings/settings-page.tsx packages/app/src/features/settings/settings.css
git commit -m "feat(settings): add advanced desktop controls"
~~~

## Task 8: Add integration, accessibility, and documentation coverage

**Files:**
- Modify: packages/app/src/app.integration.test.tsx
- Modify: packages/app/src/accessibility.test.tsx
- Modify: packages/app/src/features/management/management-responsive.test.ts
- Create: packages/app/src/features/settings/settings-responsive.test.ts
- Modify: packages/app/src/styles/contrast.test.ts
- Modify: packages/desktop/README.md

**Step 1: Write the failing complete journey**

Cover:

1. Home Settings entry.
2. Set startup Home and light theme.
3. Choose 每次询问 under 权限与安全 and assert fake backend state.
4. Select pwsh and invoke config reveal.
5. Assert every requested deferred setting is visible and disabled.
6. Return to Home.
7. Open project/Session, enter Settings via workspace footer, and return to the same Session route.

Add keyboard tests for triggers, page tabs, radio groups, placeholders, and back focus. Add light-theme contrast assertions.

**Step 2: Run tests to verify failure**

Run: bun run --cwd packages/app test -- src/app.integration.test.tsx src/accessibility.test.tsx src/features/settings/settings-responsive.test.ts src/styles/contrast.test.ts

Expected: FAIL until the complete app is wired.

**Step 3: Implement only test-driven fixes**

Address focus restoration, overflow, semantic labels, and light-theme contrast failures. Do not expand deferred systems.

**Step 4: Update documentation**

Document both Settings entry points, return behavior, desktop-versus-global persistence, new-Session permission scope, config reveal safety, and the complete deferred list.

**Step 5: Run verification**

~~~powershell
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd packages/desktop typecheck
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
bun test packages/jyycode/test/server/global-default-permission.test.ts --timeout 30000
git diff --check
~~~

Expected: all settings tests pass. If the known unrelated composer/permission-mode.ts typecheck baseline appears, record it and verify no Settings file is listed.

**Step 6: Commit**

~~~powershell
git add packages/app/src/app.integration.test.tsx packages/app/src/accessibility.test.tsx packages/app/src/features/management/management-responsive.test.ts packages/app/src/features/settings/settings-responsive.test.ts packages/app/src/styles/contrast.test.ts packages/desktop/README.md
git commit -m "test(desktop): cover settings workflows"
~~~

## Manual acceptance walkthrough

1. At 1280×820, confirm Home Settings opens full-screen without the management rail.
2. Switch to light theme, visit Home, Skill, MCP, and a workspace, then restart and confirm persistence/readability.
3. Select 启动时显示 Home, open a Session, restart, and confirm Home opens. Change back to restore and confirm the previous Session restores.
4. Set 每次询问, create a new Session, and verify the new default. Add fine-grained config rules and confirm Settings reports 自定义配置 without silently changing it.
5. Set the Shell, restart backend/session, and confirm it is used. Click 打开全局配置文件 and confirm Explorer selects the configuration file.
6. Confirm language, liquid glass, all three notification triggers, auto update, compression, and memory management show 即将推出 and cannot be changed.
7. Open Settings from an active Session footer and press 返回; confirm the same Session is restored.
