import { tr } from "../../i18n/i18n-context"
import type { DesktopBridge, DesktopNotificationPermission } from "../../platform/types"
import type { DesktopSettings } from "../settings/settings-preferences"

export type DesktopNotificationEvent =
  | { kind: "status"; eventID: string; sessionID: string; status: "running" | "retry" | "idle" }
  | { kind: "permission"; eventID: string }
  | { kind: "question"; eventID: string }

type Options = {
  bridge: DesktopBridge
  settings: () => DesktopSettings
  focused?: () => boolean
  permission?: DesktopNotificationPermission
}

const subscribers = new Set<(event: DesktopNotificationEvent) => void>()
const permissionSubscribers = new Set<(permission: DesktopNotificationPermission) => void>()

export function publishDesktopNotificationEvent(event: DesktopNotificationEvent) {
  for (const subscriber of subscribers) subscriber(event)
}

export function publishDesktopNotificationPermission(permission: DesktopNotificationPermission) {
  for (const subscriber of permissionSubscribers) subscriber(permission)
}

export function createDesktopNotifications(options: Options) {
  const seen = new Set<string>()
  const previousStatus = new Map<string, "running" | "retry" | "idle">()
  let permission = options.permission ?? "default"
  let disposed = false
  let started = false
  let focused = options.focused?.() ?? document.hasFocus()

  const onFocus = () => (focused = true)
  const onBlur = () => (focused = false)
  const isFocused = () => options.focused?.() ?? focused

  async function notify(kind: "completion" | "permission" | "question") {
    if (disposed || isFocused() || permission !== "granted" || !options.settings().notifications[kind]) return
    await options.bridge.sendNotification({
      title: "JYYCode",
      body: tr(
        kind === "completion"
          ? "notifications.reply-completed"
          : kind === "permission"
            ? "notifications.permission-required"
            : "notifications.question-required",
      ),
    })
  }

  async function handle(event: DesktopNotificationEvent) {
    if (disposed || seen.has(event.eventID)) return
    seen.add(event.eventID)
    if (seen.size > 2_048) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }

    if (event.kind === "status") {
      const previous = previousStatus.get(event.sessionID)
      previousStatus.set(event.sessionID, event.status)
      if (event.status === "idle" && (previous === "running" || previous === "retry")) {
        await notify("completion")
      }
      return
    }
    await notify(event.kind)
  }

  const subscriber = (event: DesktopNotificationEvent) => void handle(event)
  const permissionSubscriber = (value: DesktopNotificationPermission) => (permission = value)

  function start() {
    if (started || disposed) return
    started = true
    subscribers.add(subscriber)
    permissionSubscribers.add(permissionSubscriber)
    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", onBlur)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    subscribers.delete(subscriber)
    permissionSubscribers.delete(permissionSubscriber)
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("blur", onBlur)
  }

  return {
    start,
    dispose,
    handle,
    setPermission(value: DesktopNotificationPermission) {
      permission = value
    },
  }
}
