import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopClient } from "../../data/sdk"
import type { DesktopBridge, LastLocation } from "../../platform/types"
import { createLifecycleController, safeFailureMessage } from "./lifecycle-controller"
import { defaultDesktopSettings } from "../settings/settings-preferences"

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
    loadSettings: vi.fn(async () => defaultDesktopSettings),
    saveSettings: vi.fn(async () => undefined),
    requestNotificationPermission: vi.fn(),
    sendNotification: vi.fn(),
    checkForUpdate: vi.fn(),
    installAvailableUpdate: vi.fn(),
    saveTextFile: vi.fn(),
    revealConfigFile: vi.fn(async () => undefined),
  }
  const sdk = {
    project: {
      current: vi.fn(async (_input: { directory: string }, _options: { throwOnError: boolean }) => ({ data: project })),
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

afterEach(() => vi.useRealTimers())

describe("createLifecycleController", () => {
  it("leaves the loading screen with a recoverable failure when bootstrap stalls", async () => {
    vi.useFakeTimers()
    const { bridge, sdk } = harness({})
    vi.mocked(bridge.bootstrap).mockImplementation(() => new Promise(() => {}))
    const controller = createLifecycleController({
      bridge,
      clientFor: () => sdk as unknown as DesktopClient,
      bootstrapTimeoutMs: 25,
    })

    const started = controller.start()
    await vi.advanceTimersByTimeAsync(25)
    await started

    expect(controller.phase()).toBe("failed")
    expect(controller.failure()).toContain("启动超时")
    expect(controller.recoveryAvailable()).toBe(true)
  })

  it("does not stay loading when the last-location store stalls", async () => {
    vi.useFakeTimers()
    const { bridge, sdk } = harness({})
    vi.mocked(bridge.loadLastLocation).mockImplementation(() => new Promise(() => {}))
    const controller = createLifecycleController({
      bridge,
      clientFor: () => sdk as unknown as DesktopClient,
      restoreTimeoutMs: 25,
    })

    const started = controller.start()
    await vi.advanceTimersByTimeAsync(25)
    await started

    expect(controller.phase()).toBe("ready")
    expect(controller.project()).toBeUndefined()
  })

  it("skips last-location restoration when startup is set to Home", async () => {
    const { bridge, controller } = harness()
    vi.mocked(bridge.loadSettings).mockResolvedValue({ ...defaultDesktopSettings, startup: "home" })

    await controller.start()

    expect(bridge.loadLastLocation).not.toHaveBeenCalled()
    expect(controller.route()).toBe("/")
    expect(controller.phase()).toBe("ready")
    expect(controller.settings()).toEqual({ ...defaultDesktopSettings, startup: "home" })
  })

  it("does not stay loading when the previous project stalls", async () => {
    vi.useFakeTimers()
    const { bridge, sdk } = harness({ project: directory })
    sdk.project.current.mockImplementation(() => new Promise(() => {}))
    const controller = createLifecycleController({
      bridge,
      clientFor: () => sdk as unknown as DesktopClient,
      restoreTimeoutMs: 25,
    })

    const started = controller.start()
    await vi.advanceTimersByTimeAsync(25)
    await started

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/")
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({})
  })

  it("does not stay loading when the previous Session stalls", async () => {
    vi.useFakeTimers()
    const { bridge, sdk } = harness()
    sdk.session.get.mockImplementation(() => new Promise(() => {}))
    const controller = createLifecycleController({
      bridge,
      clientFor: () => sdk as unknown as DesktopClient,
      restoreTimeoutMs: 25,
    })

    const started = controller.start()
    await vi.advanceTimersByTimeAsync(25)
    await started

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/workspace")
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({
      project: directory,
      openProjects: [{ path: directory }],
    })
  })

  it("restores a valid last project and Session", async () => {
    const { bridge, controller, sdk } = harness()

    await controller.start()

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/session/ses_1")
    expect(controller.project()?.directory).toBe(directory)
    expect(sdk.project.current).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(sdk.session.get).toHaveBeenCalledWith({ directory, sessionID: session.id }, { throwOnError: true })
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({
      project: directory,
      sessionID: session.id,
      openProjects: [{ path: directory, sessionID: session.id }],
    })
  })

  it("restores every open project in order and reselects the previous active project", async () => {
    const other = "C:\\work\\other"
    const { controller, sdk } = harness({
      project: directory,
      sessionID: session.id,
      openProjects: [
        { path: directory, sessionID: session.id },
        { path: other, sessionID: "ses_other" },
      ],
    })

    await controller.start()

    expect(
      controller
        .projects()
        ?.openProjects()
        .map((item) => item.directory),
    ).toEqual([directory, other])
    expect(controller.project()?.directory).toBe(directory)
    expect(controller.projects()?.sessionFor(other)).toBe("ses_other")
    expect(sdk.project.current.mock.calls.map(([input]) => input.directory)).toEqual([directory, other])
  })

  it("falls back to the project empty state when the Session was deleted", async () => {
    const { bridge, controller, sdk } = harness()
    sdk.session.get.mockRejectedValueOnce(new Error("not found"))

    await controller.start()

    expect(controller.phase()).toBe("ready")
    expect(controller.route()).toBe("/workspace")
    expect(controller.project()?.directory).toBe(directory)
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({
      project: directory,
      openProjects: [{ path: directory }],
    })
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
