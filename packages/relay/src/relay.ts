import {
  type RelayEnvelope,
  type RelayHello,
  type RelayNotification,
  type RelayPushToken,
  parseRelayMessage,
  protocolError,
} from "@jyycode-ai/mobile-protocol"
import type { ServerWebSocket } from "bun"
import { resolve, sep } from "node:path"
import { configuredPushSender, type PushSender } from "./push"

type SocketData = {
  hello?: RelayHello
  messageIDs: Set<string>
  windowStartedAt: number
  envelopeCount: number
  pairingCount: number
}

export type RelayOptions = {
  hostname?: string
  port?: number
  pushSender?: PushSender
  /** Optional built Safari/PWA directory, served beside the relay on one local port. */
  staticRoot?: string
}

export type Relay = {
  hostname: string
  port: number
  stop: () => void
}

const MAX_RECENT_MESSAGE_IDS = 1_000
const RATE_WINDOW_MS = 60_000
const MAX_ENVELOPES_PER_WINDOW = 120
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 5

export function createRelay(options: RelayOptions = {}): Relay {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 8787
  const routes = new Map<string, Map<string, ServerWebSocket<SocketData>>>()
  const pushTokens = new Map<string, Map<string, string>>()
  const pushSender = options.pushSender ?? configuredPushSender()
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : undefined
  const server = Bun.serve<SocketData>({
    hostname,
    port,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true })
      if (
        url.pathname === "/connect" &&
        server.upgrade(request, {
          data: { messageIDs: new Set(), windowStartedAt: Date.now(), envelopeCount: 0, pairingCount: 0 },
        })
      )
        return
      if (staticRoot && request.method === "GET") return serveStatic(staticRoot, url.pathname)
      return new Response("Not found", { status: 404 })
    },
    websocket: {
      message(socket, raw) {
        const parsed = decode(raw)
        if (!parsed) return sendError(socket, "invalid_message")
        const message = parseRelayMessage(parsed)
        if (message.type === "relay.error") {
          socket.send(JSON.stringify(message))
          return
        }
        if (message.type === "relay.ping") {
          socket.send(JSON.stringify({ type: "relay.pong" }))
          return
        }
        if (message.type === "relay.hello") return register(routes, socket, message)
        if (message.type === "relay.push-token") return registerPushToken(pushTokens, socket, message)
        if (message.type === "relay.notification") return void sendNotification(pushTokens, pushSender, socket, message)
        forward(routes, socket, message)
      },
      close(socket) {
        unregister(routes, socket)
      },
    },
  })

  return { hostname: server.hostname ?? hostname, port: server.port ?? port, stop: () => server.stop(true) }
}

async function serveStatic(root: string, pathname: string): Promise<Response> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response("Bad request", { status: 400 })
  }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "")
  const candidate = resolve(root, requested)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return new Response("Not found", { status: 404 })

  const file = Bun.file(candidate)
  if (await file.exists()) return staticResponse(file, requested)
  // Client-side routes must load the PWA shell; missing assets must still 404.
  if (requested.includes(".")) return new Response("Not found", { status: 404 })
  return staticResponse(Bun.file(resolve(root, "index.html")), "index.html")
}

function staticResponse(file: Blob, filename: string) {
  const immutable = filename.startsWith("assets/")
  return new Response(file, {
    headers: {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function registerPushToken(
  tokens: Map<string, Map<string, string>>,
  socket: ServerWebSocket<SocketData>,
  message: RelayPushToken,
) {
  const hello = socket.data.hello
  if (!hello || hello.role !== "desktop" || hello.routeID !== message.routeID)
    return sendError(socket, "not_registered")
  const routeTokens = tokens.get(message.routeID) ?? new Map()
  routeTokens.set(message.deviceID, message.token)
  tokens.set(message.routeID, routeTokens)
}

async function sendNotification(
  tokens: Map<string, Map<string, string>>,
  sender: PushSender | undefined,
  socket: ServerWebSocket<SocketData>,
  message: RelayNotification,
) {
  const hello = socket.data.hello
  if (!hello || hello.role !== "desktop" || hello.routeID !== message.routeID)
    return sendError(socket, "not_registered")
  const token = tokens.get(message.routeID)?.get(message.deviceID)
  if (!token || !sender) return
  try {
    await sender(token, message)
  } catch {
    // Push delivery failures are intentionally not logged with token or task metadata.
  }
}

function register(
  routes: Map<string, Map<string, ServerWebSocket<SocketData>>>,
  socket: ServerWebSocket<SocketData>,
  hello: RelayHello,
) {
  unregister(routes, socket)
  const clients = routes.get(hello.routeID) ?? new Map()
  routes.set(hello.routeID, clients)
  clients.set(hello.clientID, socket)
  socket.data.hello = hello
  socket.send(JSON.stringify({ type: "relay.ready", routeID: hello.routeID, clientID: hello.clientID }))
}

function forward(
  routes: Map<string, Map<string, ServerWebSocket<SocketData>>>,
  socket: ServerWebSocket<SocketData>,
  envelope: RelayEnvelope,
) {
  const hello = socket.data.hello
  if (!hello || hello.routeID !== envelope.routeID || hello.clientID !== envelope.senderID) {
    return sendError(socket, "not_registered")
  }
  if (socket.data.messageIDs.has(envelope.messageID)) return
  if (isRateLimited(socket, envelope)) return sendError(socket, "rate_limited")
  remember(socket.data.messageIDs, envelope.messageID)
  const recipient = routes.get(envelope.routeID)?.get(envelope.recipientID)
  if (recipient) recipient.send(JSON.stringify(envelope))
}

function isRateLimited(socket: ServerWebSocket<SocketData>, envelope: RelayEnvelope) {
  const now = Date.now()
  if (now - socket.data.windowStartedAt >= RATE_WINDOW_MS) {
    socket.data.windowStartedAt = now
    socket.data.envelopeCount = 0
    socket.data.pairingCount = 0
  }
  socket.data.envelopeCount += 1
  if (socket.data.envelopeCount > MAX_ENVELOPES_PER_WINDOW) return true
  if (!envelope.pairingPublicKey) return false
  socket.data.pairingCount += 1
  return socket.data.pairingCount > MAX_PAIRING_ATTEMPTS_PER_WINDOW
}

function unregister(
  routes: Map<string, Map<string, ServerWebSocket<SocketData>>>,
  socket: ServerWebSocket<SocketData>,
) {
  const hello = socket.data.hello
  if (!hello) return
  const clients = routes.get(hello.routeID)
  clients?.delete(hello.clientID)
  if (clients?.size === 0) routes.delete(hello.routeID)
  socket.data.hello = undefined
}

function remember(messageIDs: Set<string>, messageID: string) {
  messageIDs.add(messageID)
  if (messageIDs.size <= MAX_RECENT_MESSAGE_IDS) return
  const first = messageIDs.values().next().value
  if (first) messageIDs.delete(first)
}

function decode(value: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value))
  } catch {
    return undefined
  }
}

function sendError(socket: ServerWebSocket<SocketData>, code: Parameters<typeof protocolError>[0]) {
  socket.send(JSON.stringify(protocolError(code)))
}
