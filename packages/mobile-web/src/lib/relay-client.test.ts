import "fake-indexeddb/auto"
import { expect, test, vi } from "vitest"
import { encryptPayload, sealSessionKey } from "./crypto"
import { RelayClient } from "./relay-client"

test("连接后请求权威任务摘要，并忽略中继以外的内容", async () => {
  const sessionKey = crypto.getRandomValues(new Uint8Array(32))
  const sealed = await sealSessionKey(sessionKey)
  const tasks: unknown[] = []
  const original = globalThis.WebSocket

  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = FakeSocket.CONNECTING
    onopen?: () => void
    onmessage?: (event: MessageEvent) => void
    onerror?: () => void
    onclose?: () => void
    constructor(_url: string) { queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.onopen?.() }) }
    send(raw: string) {
      const message = JSON.parse(raw) as Record<string, unknown>
      if (message.type === "relay.hello") {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "relay.ready" }) } as MessageEvent))
        return
      }
      const response = {
        type: "relay.envelope", protocolVersion: 1, routeID: "desktop_test", senderID: "desktop_test", recipientID: "web_test", messageID: "response_1",
        correlationID: message.correlationID, sequence: 1, ciphertext: encryptPayload(sessionKey, { type: "summaryResult", tasks: [] }),
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) } as MessageEvent))
    }
    close() { this.readyState = 3; this.onclose?.() }
  }

  vi.stubGlobal("WebSocket", FakeSocket)
  try {
    const client = new RelayClient({ onTasks: (value) => tasks.push(...value) })
    await client.restore({ id: "web_test", name: "Safari 浏览器", routeId: "desktop_test", relayUrl: "wss://relay.example.test/connect", ...sealed, pairedAt: Date.now() }, sessionKey)
    expect(tasks).toEqual([])
    client.disconnect()
  } finally {
    vi.unstubAllGlobals()
    if (original) globalThis.WebSocket = original
  }
})
