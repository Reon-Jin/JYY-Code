import { expect, test } from "vitest"
import { decryptPayload, encryptPayload, parsePairingInvitation } from "./crypto"

test("rejects an expired pairing QR code", () => {
  expect(() =>
    parsePairingInvitation({
      routeId: "desktop_1",
      relayUrl: "wss://relay.example.test/connect",
      pairingSecret: "a".repeat(64),
      temporaryPublicKey: "b".repeat(64),
      expiresAt: 1,
    }),
  ).toThrow("二维码已失效")
})

test("round-trips an opaque encrypted relay payload", () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const ciphertext = encryptPayload(key, { type: "summary", taskText: "不能由中继读取" })
  expect(ciphertext).not.toContain("不能由中继读取")
  expect(decryptPayload<{ type: string; taskText: string }>(key, ciphertext)).toEqual({
    type: "summary",
    taskText: "不能由中继读取",
  })
})
