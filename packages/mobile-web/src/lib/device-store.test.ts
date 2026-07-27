import "fake-indexeddb/auto"
import { expect, test } from "vitest"
import { DeviceStore } from "./device-store"

test("removing a paired browser deletes its persisted local key material", async () => {
  const store = new DeviceStore()
  const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  await store.put({
    id: "web_test",
    name: "Safari 浏览器",
    routeId: "desktop_test",
    relayUrl: "wss://relay.example.test/connect",
    vaultKey,
    sealedSessionKey: "encrypted-key",
    pairedAt: Date.now(),
  })
  expect(await store.get("web_test")).toMatchObject({ id: "web_test", sealedSessionKey: "encrypted-key" })
  await store.remove("web_test")
  expect(await store.get("web_test")).toBeUndefined()
})
