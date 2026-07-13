import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import type { DesktopClient } from "../../data/sdk"
import type { DesktopBridge, LastLocation } from "../../platform/types"
import { createLifecycleController, safeFailureMessage } from "./lifecycle-controller"

const directory = "C:\\work\\demo"
const bootstrap = { baseUrl: "http://127.0.0.1:4096", username: "jyycode", password: "secret" }
const project: Project = {
  id: "pro_1",
  worktree: directory,
  time: { created: 1, updated: 1 },
  sandboxes: [],
}
const session: Session = {
  id: "ses_1",
  slug: "restored",
  projectID: project.id,
  directory,
  title: "Restored",
  version: "test",
  time: { created: 1, updated: 1 },
}

function harness(location: LastLocation = { project: directory, sessionID: session.id }) {
  const bridge: DesktopBridge = {
    bootstrap: vi.fn(async () => bootstrap),
    restartBackend: vi.fn(async () => undefined),
    chooseDirectory: vi.fn(),
    createProjectDirectory: vi.fn(),
    loadRecentProjects: vi.fn(async () => []),
    saveRecentProjects: vi.fn(async () => undefined),
    loadLastLocation: vi.fn(async () => location),
    saveLastLocation: vi.fn(async () => undefined),
  }
  const sdk = {
    project: {
      current: vi.fn(async () => ({ data: project })),
    },
    session: {
      get: vi.fn(async () => ({ data: session })),
    },
  }
  const controller = createLifecycleController({
    bridge,
    clientFor: () => sdk as unknown as DesktopClient,
  })
  return { bridge, controller, sdk }
}

describe("createLifecycleController", () => {
  it("restores a valid last project and Session", async () => {
    const { bridge, controller, sdk } = harness()

    await controller.start()

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/session/ses_1")
    expect(controller.project()?.directory).toBe(directory)
    expect(sdk.project.current).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(sdk.session.get).toHaveBeenCalledWith(
      { directory, sessionID: session.id },
      { throwOnError: true },
    )
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({ project: directory, sessionID: session.id })
  })

  it("falls back to the project empty state when the Session was deleted", async () => {
    const { bridge, controller, sdk } = harness()
    sdk.session.get.mockRejectedValueOnce(new Error("not found"))

    await controller.start()

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/")
    expect(controller.project()?.directory).toBe(directory)
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({ project: directory })
  })

  it("returns to project selection when the stored project is unavailable", async () => {
    const { bridge, controller, sdk } = harness()
    sdk.project.current.mockRejectedValueOnce(new Error("directory missing"))

    await controller.start()

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/")
    expect(controller.project()).toBeUndefined()
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({})
  })

  it("does not loop forever after a second backend failure", async () => {
    const { bridge, controller } = harness({})
    vi.mocked(bridge.restartBackend).mockRejectedValue(new Error("still broken"))

    await controller.recover()
    await controller.recover()

    expect(bridge.restartBackend).toHaveBeenCalledTimes(1)
    expect(controller.phase()).toBe("failed")
    expect(controller.recoveryAvailable()).toBe(false)
  })

  it("redacts authorization and environment values from displayed failures", () => {
    const message = safeFailureMessage(
      new Error("Authorization: Basic am55Y29kZTpzZWNyZXQ= JYYCODE_SERVER_PASSWORD=secret"),
    )

    expect(message).not.toContain("am55Y29kZTpzZWNyZXQ")
    expect(message).not.toContain("=secret")
    expect(message).toContain("[已隐藏]")
  })
})
