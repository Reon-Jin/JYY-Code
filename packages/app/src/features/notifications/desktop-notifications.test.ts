import { describe, expect, it, vi } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings } from "../settings/settings-preferences"
import {
  createDesktopNotifications,
  publishDesktopNotificationEvent,
  publishDesktopNotificationPermission,
} from "./desktop-notifications"

function createHarness(input?: { focused?: boolean; permission?: "granted" | "denied" | "unsupported" }) {
  const desktop = createFakeDesktop()
  let focused = input?.focused ?? false
  const notifications = createDesktopNotifications({
    bridge: desktop.bridge,
    settings: () => defaultDesktopSettings,
    focused: () => focused,
    permission: input?.permission ?? "granted",
  })
  return { desktop, notifications, focus: (value: boolean) => (focused = value) }
}

describe("desktop notifications", () => {
  it("does not notify while focused or without permission", async () => {
    const focused = createHarness({ focused: true, permission: "granted" })
    await focused.notifications.handle({ kind: "permission", eventID: "permission-focused" })
    expect(focused.desktop.bridge.sendNotification).not.toHaveBeenCalled()

    for (const permission of ["denied", "unsupported"] as const) {
      const harness = createHarness({ permission })
      await harness.notifications.handle({ kind: "permission", eventID: `permission-${permission}` })
      expect(harness.desktop.bridge.sendNotification).not.toHaveBeenCalled()
    }
  })

  it("only treats a running or retry to idle transition as completion", async () => {
    const { desktop, notifications } = createHarness()
    await notifications.handle({ kind: "status", eventID: "idle-first", sessionID: "ses_1", status: "idle" })
    await notifications.handle({ kind: "status", eventID: "running", sessionID: "ses_1", status: "running" })
    await notifications.handle({ kind: "status", eventID: "idle-done", sessionID: "ses_1", status: "idle" })
    await notifications.handle({ kind: "status", eventID: "retry", sessionID: "ses_2", status: "retry" })
    await notifications.handle({ kind: "status", eventID: "idle-retry", sessionID: "ses_2", status: "idle" })

    expect(desktop.bridge.sendNotification).toHaveBeenCalledTimes(2)
  })

  it("dispatches enabled permission and question events with generic content", async () => {
    const { desktop, notifications } = createHarness()
    await notifications.handle({ kind: "permission", eventID: "permission-1" })
    await notifications.handle({ kind: "question", eventID: "question-1" })

    expect(desktop.bridge.sendNotification).toHaveBeenCalledTimes(2)
    expect(desktop.bridge.sendNotification).toHaveBeenCalledWith({
      title: "JYYCode",
      body: expect.not.stringMatching(/prompt|tool|directory|model|memory/i),
    })
  })

  it("deduplicates replayed event ids and stops after dispose", async () => {
    const { desktop, notifications } = createHarness()
    const event = { kind: "question", eventID: "same-question" } as const
    await notifications.handle(event)
    await notifications.handle(event)
    notifications.dispose()
    await notifications.handle({ kind: "permission", eventID: "after-dispose" })

    expect(desktop.bridge.sendNotification).toHaveBeenCalledTimes(1)
  })

  it("respects each independently persisted preference", async () => {
    const desktop = createFakeDesktop()
    const notifications = createDesktopNotifications({
      bridge: desktop.bridge,
      permission: "granted",
      settings: () => ({
        ...defaultDesktopSettings,
        notifications: { completion: false, permission: false, question: true },
      }),
    })
    await notifications.handle({ kind: "permission", eventID: "permission-off" })
    await notifications.handle({ kind: "question", eventID: "question-on" })

    expect(desktop.bridge.sendNotification).toHaveBeenCalledTimes(1)
  })

  it("receives global events and permission changes until disposed", async () => {
    const desktop = createFakeDesktop()
    const notifications = createDesktopNotifications({
      bridge: desktop.bridge,
      permission: "default",
      settings: () => defaultDesktopSettings,
    })
    notifications.start()
    publishDesktopNotificationEvent({ kind: "question", eventID: "before-permission" })
    publishDesktopNotificationPermission("granted")
    publishDesktopNotificationEvent({ kind: "question", eventID: "after-permission" })
    await vi.waitFor(() => expect(desktop.bridge.sendNotification).toHaveBeenCalledOnce())
    notifications.dispose()
  })
})
