import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopBridge } from "./platform/types"
import { App } from "./app"

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
  }
}

describe("App", () => {
  afterEach(cleanup)

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

    expect(await screen.findByRole("heading", { name: /让代码保持流动/ })).toBeVisible()
    const actions = [
      screen.getByRole("button", { name: /打开现有目录/ }),
      screen.getByRole("button", { name: /新建项目/ }),
    ]
    expect(actions).toHaveLength(2)
    for (const action of actions) expect(action).toHaveAttribute("data-variant", "primary")
  })
})
