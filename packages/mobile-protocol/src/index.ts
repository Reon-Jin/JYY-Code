/**
 * The relay treats ciphertext as opaque. Cryptographic keys and decrypted task
 * data must never be sent to, or stored by, the relay service.
 */
export const PROTOCOL_VERSION = 1
export const MAX_CIPHERTEXT_BYTES = 64 * 1024

/**
 * `mobile` is retained for already-paired native clients. New Safari/PWA
 * clients identify themselves as `web`; both roles are opaque relay peers.
 */
export type RelayRole = "desktop" | "mobile" | "web"

export type RelayHello = {
  type: "relay.hello"
  protocolVersion: typeof PROTOCOL_VERSION
  routeID: string
  clientID: string
  role: RelayRole
}

export type RelayEnvelope = {
  type: "relay.envelope"
  protocolVersion: typeof PROTOCOL_VERSION
  routeID: string
  senderID: string
  recipientID: string
  messageID: string
  correlationID?: string
  pairingPublicKey?: string
  sequence: number
  ciphertext: string
}

export type RelayPing = {
  type: "relay.ping"
}

export type RelayPushToken = {
  type: "relay.push-token"
  protocolVersion: typeof PROTOCOL_VERSION
  routeID: string
  deviceID: string
  token: string
}

export type RelayNotification = {
  type: "relay.notification"
  protocolVersion: typeof PROTOCOL_VERSION
  routeID: string
  deviceID: string
  kind: "attention" | "failed" | "completed"
}

export type RelayMessage = RelayHello | RelayEnvelope | RelayPing | RelayPushToken | RelayNotification

export type ProtocolErrorCode =
  | "invalid_message"
  | "unsupported_version"
  | "message_too_large"
  | "not_registered"
  | "rate_limited"

export type ProtocolError = {
  type: "relay.error"
  code: ProtocolErrorCode
}

export function parseRelayMessage(value: unknown): RelayMessage | ProtocolError {
  if (!isRecord(value) || typeof value.type !== "string") return protocolError("invalid_message")
  if (value.type === "relay.ping") return { type: "relay.ping" }
  if (value.protocolVersion !== PROTOCOL_VERSION) return protocolError("unsupported_version")

  if (value.type === "relay.hello") {
    if (!isIdentifier(value.routeID) || !isIdentifier(value.clientID) || !isRole(value.role))
      return protocolError("invalid_message")
    return {
      type: "relay.hello",
      protocolVersion: PROTOCOL_VERSION,
      routeID: value.routeID,
      clientID: value.clientID,
      role: value.role,
    }
  }

  if (value.type === "relay.push-token") {
    if (!isIdentifier(value.routeID) || !isIdentifier(value.deviceID) || !isPushToken(value.token))
      return protocolError("invalid_message")
    return {
      type: "relay.push-token",
      protocolVersion: PROTOCOL_VERSION,
      routeID: value.routeID,
      deviceID: value.deviceID,
      token: value.token,
    }
  }

  if (value.type === "relay.notification") {
    if (!isIdentifier(value.routeID) || !isIdentifier(value.deviceID) || !isNotificationKind(value.kind))
      return protocolError("invalid_message")
    return {
      type: "relay.notification",
      protocolVersion: PROTOCOL_VERSION,
      routeID: value.routeID,
      deviceID: value.deviceID,
      kind: value.kind,
    }
  }

  if (value.type === "relay.envelope") {
    if (
      !isIdentifier(value.routeID) ||
      !isIdentifier(value.senderID) ||
      !isIdentifier(value.recipientID) ||
      !isIdentifier(value.messageID) ||
      !isSequence(value.sequence) ||
      typeof value.ciphertext !== "string"
    ) {
      return protocolError("invalid_message")
    }
    if (value.correlationID !== undefined && !isIdentifier(value.correlationID)) return protocolError("invalid_message")
    if (value.pairingPublicKey !== undefined && !isHexKey(value.pairingPublicKey))
      return protocolError("invalid_message")
    if (new TextEncoder().encode(value.ciphertext).byteLength > MAX_CIPHERTEXT_BYTES)
      return protocolError("message_too_large")
    return {
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: value.routeID,
      senderID: value.senderID,
      recipientID: value.recipientID,
      messageID: value.messageID,
      ...(value.correlationID === undefined ? {} : { correlationID: value.correlationID }),
      ...(value.pairingPublicKey === undefined ? {} : { pairingPublicKey: value.pairingPublicKey }),
      sequence: value.sequence,
      ciphertext: value.ciphertext,
    }
  }

  return protocolError("invalid_message")
}

export function protocolError(code: ProtocolErrorCode): ProtocolError {
  return { type: "relay.error", code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function isRole(value: unknown): value is RelayRole {
  return value === "desktop" || value === "mobile" || value === "web"
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isHexKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function isPushToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32,400}$/i.test(value)
}

function isNotificationKind(value: unknown): value is RelayNotification["kind"] {
  return value === "attention" || value === "failed" || value === "completed"
}
