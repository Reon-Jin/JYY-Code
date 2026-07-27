import { expect, test } from "bun:test"
import { MAX_CIPHERTEXT_BYTES, PROTOCOL_VERSION, parseRelayMessage } from "../src"

test("accepts a valid opaque envelope", () => {
  expect(
    parseRelayMessage({
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      senderID: "phone_1",
      recipientID: "desktop_1",
      messageID: "message_1",
      sequence: 7,
      ciphertext: "base64-ciphertext",
    }),
  ).toEqual({
    type: "relay.envelope",
    protocolVersion: PROTOCOL_VERSION,
    routeID: "desktop_1",
    senderID: "phone_1",
    recipientID: "desktop_1",
    messageID: "message_1",
    sequence: 7,
    ciphertext: "base64-ciphertext",
  })
})

test("accepts a Safari web client without adding task fields to the relay protocol", () => {
  expect(
    parseRelayMessage({
      type: "relay.hello",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      clientID: "safari_1",
      role: "web",
    }),
  ).toEqual({
    type: "relay.hello",
    protocolVersion: PROTOCOL_VERSION,
    routeID: "desktop_1",
    clientID: "safari_1",
    role: "web",
  })
})

test("rejects unsupported versions and oversized ciphertext without inspecting it", () => {
  expect(parseRelayMessage({ type: "relay.hello", protocolVersion: 2 })).toEqual({
    type: "relay.error",
    code: "unsupported_version",
  })
  expect(
    parseRelayMessage({
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      senderID: "phone_1",
      recipientID: "desktop_1",
      messageID: "message_1",
      sequence: 0,
      ciphertext: "a".repeat(MAX_CIPHERTEXT_BYTES + 1),
    }),
  ).toEqual({ type: "relay.error", code: "message_too_large" })
})

test("allows a pairing envelope to carry only the ephemeral public key outside ciphertext", () => {
  expect(
    parseRelayMessage({
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      senderID: "phone_1",
      recipientID: "desktop_1",
      messageID: "pair_1",
      pairingPublicKey: "a".repeat(64),
      sequence: 0,
      ciphertext: "encrypted-pairing-request",
    }),
  ).toMatchObject({ pairingPublicKey: "a".repeat(64) })
})

test("accepts only metadata-only push registration and generic notification kinds", () => {
  expect(
    parseRelayMessage({
      type: "relay.push-token",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      deviceID: "phone_1",
      token: "a".repeat(64),
    }),
  ).toMatchObject({ type: "relay.push-token" })
  expect(
    parseRelayMessage({
      type: "relay.notification",
      protocolVersion: PROTOCOL_VERSION,
      routeID: "desktop_1",
      deviceID: "phone_1",
      kind: "task body must not be here",
    }),
  ).toEqual({ type: "relay.error", code: "invalid_message" })
})
