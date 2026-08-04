import { afterEach, expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "@jyycode-ai/mobile-protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRelay, type Relay } from "../src/relay"

let relay: Relay | undefined

afterEach(() => relay?.stop())

test("routes opaque envelopes only to the registered Safari recipient", async () => {
  relay = createRelay({ port: 0 })
  const base = `ws://127.0.0.1:${relay.port}/connect`
  const desktop = new WebSocket(base)
  const safari = new WebSocket(base)
  await Promise.all([opened(desktop), opened(safari)])
  desktop.send(JSON.stringify(hello("desktop")))
  safari.send(JSON.stringify(hello("safari")))
  await Promise.all([nextMessage(desktop), nextMessage(safari)])

  const received = nextMessage(desktop)
  safari.send(
    JSON.stringify({
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "route_1",
      senderID: "safari",
      recipientID: "desktop",
      messageID: "command_1",
      sequence: 1,
      ciphertext: "ciphertext-only",
    }),
  )

  expect(await received).toMatchObject({ type: "relay.envelope", ciphertext: "ciphertext-only" })
  desktop.close()
  safari.close()
})

test("rejects envelopes from an unregistered client", async () => {
  relay = createRelay({ port: 0 })
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/connect`)
  await opened(socket)
  const received = nextMessage(socket)
  socket.send(
    JSON.stringify({
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "route_1",
      senderID: "phone",
      recipientID: "desktop",
      messageID: "command_1",
      sequence: 1,
      ciphertext: "opaque",
    }),
  )
  expect(await received).toEqual({ type: "relay.error", code: "not_registered" })
  socket.close()
})

test("stores an APNs token as metadata and forwards only a generic event", async () => {
  let resolvePush: ((value: { token: string; kind: string }) => void) | undefined
  const pushed = new Promise<{ token: string; kind: string }>((resolve) => {
    resolvePush = resolve
  })
  relay = createRelay({
    port: 0,
    pushSender: async (token, notification) => resolvePush?.({ token, kind: notification.kind }),
  })
  const desktop = new WebSocket(`ws://127.0.0.1:${relay.port}/connect`)
  await opened(desktop)
  desktop.send(JSON.stringify(hello("desktop")))
  await nextMessage(desktop)
  desktop.send(
    JSON.stringify({
      type: "relay.push-token",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "route_1",
      deviceID: "phone",
      token: "a".repeat(64),
    }),
  )
  desktop.send(
    JSON.stringify({
      type: "relay.notification",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "route_1",
      deviceID: "phone",
      kind: "attention",
    }),
  )
  expect(await pushed).toEqual({ token: "a".repeat(64), kind: "attention" })
  desktop.close()
})

test("can serve a built Safari application beside the opaque relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jyycode-relay-"))
  try {
    await Bun.write(join(directory, "index.html"), "<main>JYYCode Safari</main>")
    relay = createRelay({ port: 0, staticRoot: directory })
    const response = await fetch(`http://127.0.0.1:${relay.port}/projects`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("JYYCode Safari")
    const missingAsset = await fetch(`http://127.0.0.1:${relay.port}/assets/not-present.js`)
    expect(missingAsset.status).toBe(404)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function hello(clientID: string) {
  return {
    type: "relay.hello",
    protocolVersion: PROTOCOL_VERSION,
    routeID: "route_1",
    clientID,
    role: clientID === "desktop" ? "desktop" : "web",
  }
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true })
  })
}

function nextMessage(socket: WebSocket) {
  return new Promise<unknown>((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true })
  })
}
