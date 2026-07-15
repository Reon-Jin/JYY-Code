import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackendUnavailable } from "./backend-unavailable"
import { ReconnectBanner } from "./reconnect-banner"
import { StartupLoading } from "./startup-loading"

afterEach(cleanup)

describe("lifecycle UI", () => {
  it("shows safe recovery actions and an optional log path", async () => {
    const user = userEvent.setup()
    const restart = vi.fn()
    const back = vi.fn()
    render(() => (
      <BackendUnavailable
        reason="Authorization: Basic c2VjcmV0 APP_TOKEN=secret"
        logPath={"C:\\logs\\jyycode.log"}
        recoveryAvailable
        onRestart={restart}
        onBack={back}
      />
    ))

    expect(screen.getByRole("alert")).not.toHaveTextContent("c2VjcmV0")
    expect(screen.getByRole("alert")).not.toHaveTextContent("=secret")
    expect(screen.getByText("C:\\logs\\jyycode.log")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "重新启动后端" }))
    await user.click(screen.getByRole("button", { name: "返回项目选择" }))
    expect(restart).toHaveBeenCalledOnce()
    expect(back).toHaveBeenCalledOnce()
  })

  it("describes each startup phase through a polite status", () => {
    const [phase, setPhase] = createSignal<"booting" | "backendReady" | "projectLoading">("booting")
    render(() => <StartupLoading phase={phase()} />)
    expect(screen.getByRole("status")).toHaveTextContent("正在启动 JYYCode")

    setPhase("backendReady")
    expect(screen.getByRole("status")).toHaveTextContent("正在读取上次位置")

    setPhase("projectLoading")
    expect(screen.getByRole("status")).toHaveTextContent("正在恢复项目")
  })

  it("shows a low-prominence reconnect status", () => {
    render(() => <ReconnectBanner state="disconnected" />)
    expect(screen.getByRole("status")).toHaveTextContent("连接已中断，正在重新连接")
  })
})
