import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compareDirectories } from "./verify-generated-sdk"

test("SDK verification accepts checkout line endings but detects changed code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-sdk-eol-"))
  try {
    const expected = path.join(root, "expected")
    const actual = path.join(root, "actual")
    await mkdir(expected)
    await mkdir(actual)
    await writeFile(path.join(expected, "client.ts"), "export const version = 1\r\n")
    await writeFile(path.join(actual, "client.ts"), "export const version = 1\n")
    expect(await compareDirectories(expected, actual)).toEqual({ missing: [], unexpected: [], changed: [] })
    await writeFile(path.join(actual, "client.ts"), "export const version = 2\n")
    expect((await compareDirectories(expected, actual)).changed).toEqual(["client.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
