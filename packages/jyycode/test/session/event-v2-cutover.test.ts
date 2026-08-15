import { expect, test } from "bun:test"

test("the V2 session read contract is backed by SessionMessageService", async () => {
  const source = await Bun.file(new URL("../../src/v2/session.ts", import.meta.url)).text()
  expect(source).toContain("SessionMessageService")
  expect(source).not.toMatch(/MessageTable|PartTable/)
  expect(source).toContain("messages.page")
  expect(source).toContain("messages.context")
})

