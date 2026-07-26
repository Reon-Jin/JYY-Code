import type { RelayNotification } from "@jyycode-ai/mobile-protocol"

/**
 * The public relay never receives task text. A deployment can point this
 * adapter at its APNs sender; the relay sends only a device token and a small
 * generic event class. Keeping the provider behind this interface makes it
 * possible to use Apple token auth without coupling credentials to routing.
 */
export type PushSender = (token: string, notification: RelayNotification) => Promise<void>

export function configuredPushSender(): PushSender | undefined {
  const endpoint = Bun.env.JYYCODE_PUSH_GATEWAY_URL
  if (!endpoint) return undefined
  return async (token, notification) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, kind: notification.kind }),
    })
    if (!response.ok) throw new Error(`push gateway returned ${response.status}`)
  }
}
