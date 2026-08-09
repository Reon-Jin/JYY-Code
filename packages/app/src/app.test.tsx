import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopBridge } from "./platform/types"
import { defaultDesktopSettings } from "./features/settings/settings-preferences"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"
import type { ProjectWorkspaceLoader } from "./routes"
import { withConsoleErrorCapture } from "./test/diagnostics"

function bridgeWith(bootstrap: DesktopBridge["bootstrap"]): DesktopBridge {
  return {
    bootstrap,
    restartBackend: vi.fn(),
    chooseDirectory: vi.fn(),
    createProjectDirectory: vi.fn(),
    loadRecentProjects: vi.fn(async () => []),
    saveRecentProjects: vi.fn(),
    loadLastLocation: vi.fn(async () => ({})),
    saveLastLocation: vi.fn(),
    loadSettings: vi.fn(async () => defaultDesktopSettings),
    saveSettings: vi.fn(),
    requestNotificationPermission: vi.fn(),
    sendNotification: vi.fn(),
    checkForUpdate: vi.fn(),
    installAvailableUpdate: vi.fn(),
    saveTextFile: vi.fn(),
    revealConfigFile: vi.fn(),
  }
}

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(JSON.stringify(String(input).includes("/skill") ? [] : { directory: "C:\\Users\\test" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows a non-blank startup state", () => {
    const pendingBootstrap: DesktopBridge["bootstrap"] = () => new Promise(() => undefined)
    const bridge = bridgeWith(vi.fn(pendingBootstrap))
    render(() => <App bridge={bridge} />)
    expect(screen.getByRole("status")).toHaveTextContent("正在启动 JYYCode")
  })

  it("shows project onboarding after the desktop backend starts", async () => {
    const bridge = bridgeWith(
      vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4096", username: "jyycode", password: "secret" })),
    )
    render(() => <App bridge={bridge} />)

    expect(await screen.findByRole("heading", { name: "JYYCode" })).toBeVisible()
    expect(screen.getByRole("navigation", { name: "全局管理" })).toBeVisible()
    const actions = [screen.getByRole("button", { name: "打开目录" }), screen.getByRole("button", { name: /新建项目/ })]
    expect(actions).toHaveLength(2)
    expect(actions[0]).toHaveAttribute("data-variant", "primary")
    expect(actions[1]).toHaveAttribute("data-variant", "secondary")
  })

  it("navigates between management routes without changing project state", async () => {
    const user = userEvent.setup()
    const bridge = bridgeWith(
      vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4096", username: "jyycode", password: "secret" })),
    )
    render(() => <App bridge={bridge} />)

    await user.click(await screen.findByRole("link", { name: "Skill" }))

    expect(await screen.findByRole("heading", { name: "Skill" })).toBeVisible()
    expect(screen.queryByText("ProjectWorkspace")).not.toBeInTheDocument()
    expect(bridge.createProjectDirectory).not.toHaveBeenCalled()
    expect(bridge.saveLastLocation).not.toHaveBeenCalled()
  })

  it("shows a recoverable error when desktop bootstrap fails", async () => {
    const bridge = bridgeWith(vi.fn(async () => Promise.reject(new Error("sidecar failed"))))
    render(() => <App bridge={bridge} />)

    expect(await screen.findByRole("alert")).toHaveTextContent("JYYCode 本地后端启动失败")
    expect(screen.getByRole("button", { name: "重新启动后端" })).toBeVisible()
    expect(screen.getByRole("button", { name: "返回项目选择" })).toBeVisible()
  })

  it("recovers once by restarting the backend and returns to project selection", async () => {
    const user = userEvent.setup()
    const bootstrap = vi
      .fn<DesktopBridge["bootstrap"]>()
      .mockRejectedValueOnce(new Error("sidecar failed"))
      .mockResolvedValueOnce({ baseUrl: "http://127.0.0.1:4096", username: "jyycode", password: "secret" })
    const bridge = bridgeWith(bootstrap)
    render(() => <App bridge={bridge} />)

    await user.click(await screen.findByRole("button", { name: "重新启动后端" }))

    expect(bridge.restartBackend).toHaveBeenCalledOnce()
    expect(await screen.findByRole("heading", { name: "JYYCode" })).toBeVisible()
  })

  it("shows a recoverable error when the workspace chunk fails", async () => {
    await withConsoleErrorCapture(async () => {
      const user = userEvent.setup()
      const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_route" } })
      const backend = createFakeJyycode(desktop.directory)
      backend.addSession({ id: "ses_route", slug: "route", title: "Route Session" })
      vi.stubGlobal("fetch", backend.fetch)
      const loader = vi
        .fn<ProjectWorkspaceLoader>()
        .mockRejectedValueOnce(new Error("workspace chunk failed"))
        .mockResolvedValueOnce({
          default: () => <div data-testid="workspace-ready">Workspace ready</div>,
        })

      render(() => <App bridge={desktop.bridge} workspaceLoader={loader} />)

      expect(await screen.findByRole("alert")).toHaveTextContent("工作区加载失败：workspace chunk failed")
      await user.click(screen.getByRole("button", { name: "重试加载工作区" }))
      expect(await screen.findByTestId("workspace-ready")).toHaveTextContent("Workspace ready")
      expect(loader).toHaveBeenCalledTimes(2)
    })
  })
})
