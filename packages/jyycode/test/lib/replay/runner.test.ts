import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { assertFixture, updateFixture } from "./runner"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixturePath() {
  const directory = await mkdtemp(join(tmpdir(), "jyycode-replay-runner-"))
  directories.push(directory)
  const path = join(directory, "fixture.json")
  await Bun.write(
    path,
    JSON.stringify({
      version: 1,
      workspaceSeed: { path: "/tmp/replay-workspace" },
      sessionInput: { prompt: "hello" },
      modelReplies: [],
      expected: {
        requestEnvelopes: [{ sessionID: "01JZQY7N8S8J7X8KQ5Z4N3P2M1" }],
        messages: [],
        events: [],
        files: [],
      },
      terminalStatus: { status: "completed" },
    }),
  )
  return path
}

describe("replay runner", () => {
  test("accepts a semantically equivalent observation with different runtime IDs", async () => {
    const path = await fixturePath()
    await expect(
      assertFixture(path, {
        execute: () => ({
          expected: {
            requestEnvelopes: [{ sessionID: "01JZQY7N8S8J7X8KQ5Z4N3P2M9" }],
            messages: [],
            events: [],
            files: [],
          },
          terminalStatus: { status: "completed" },
        }),
        workspaceRoots: ["/tmp/replay-workspace"],
      }),
    ).resolves.toBeDefined()
  })

  test("requires explicit local update mode", async () => {
    const path = await fixturePath()
    await expect(
      updateFixture(path, () => ({
        expected: { requestEnvelopes: [], messages: [], events: [], files: [] },
        terminalStatus: { status: "completed" },
      })),
    ).rejects.toThrow("UPDATE_REPLAY=1")
  })
})
