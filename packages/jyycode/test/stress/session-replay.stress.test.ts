import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobStore } from "../../src/storage/blob"
import { replaySession } from "../../src/cli/cmd/run/session-replay"
import type { SessionMessages } from "../../src/cli/cmd/run/session.shared"
import { runtimeBudgetProfile, stressCount, writeRuntimeMetric, peakRss } from "./runtime-metrics"

function userMessage(id: string): SessionMessages[number] {
  return {
    info: {
      id,
      sessionID: "ses_stress_replay",
      role: "user",
      time: { created: 1 },
    },
    parts: [
      {
        id: `${id}-part`,
        sessionID: "ses_stress_replay",
        messageID: id,
        type: "text",
        text: `replay event ${id}`,
      },
    ],
  } as SessionMessages[number]
}

function assistantMessage(id: string): SessionMessages[number] {
  return {
    info: {
      id,
      sessionID: "ses_stress_replay",
      role: "assistant",
      time: { created: 2 },
      parentID: "msg_stress_parent",
      modelID: "test-model",
      providerID: "test",
      mode: "chat",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-part`,
        sessionID: "ses_stress_replay",
        messageID: id,
        type: "text",
        text: `assistant replay event ${id}`,
        time: { start: 2, end: 3 },
      },
    ],
  } as SessionMessages[number]
}

function messagesFor(events: number): SessionMessages {
  const messages: SessionMessages = []
  for (let index = 0; index < events; index++) {
    const id = `msg_stress_${index}`
    messages.push(index % 2 === 0 ? userMessage(id) : assistantMessage(id))
  }
  return messages
}

function eventCounts() {
  const override = process.env.RUNTIME_STRESS_EVENTS
  if (override) {
    const values = override.split(",").map((item) => Number(item.trim()))
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
      throw new Error(`Invalid RUNTIME_STRESS_EVENTS: ${override}`)
    return values
  }
  return runtimeBudgetProfile() === "nightly" ? [5_000, 50_000] : [stressCount("events", 500, 50_000)]
}

describe("session replay stress gates", () => {
  test("replays deterministic session history at the configured event counts", async () => {
    const measurements: Array<Record<string, unknown>> = []
    for (const events of eventCounts()) {
      Bun.gc?.(true)
      const before = process.memoryUsage().rss
      const started = performance.now()
      const messages = messagesFor(events)
      const afterBuild = process.memoryUsage().rss
      const replayed = replaySession({ messages, permissions: [], questions: [], thinking: true, limits: {} })
      const duration = performance.now() - started
      const rss = peakRss(before, Math.max(afterBuild, process.memoryUsage().rss))

      expect(replayed.commits).toHaveLength(events)
      expect(replayed.patch?.phase).toBe("idle")
      measurements.push({
        events,
        duration_ms: Math.round(duration),
        peak_rss_bytes: rss,
        terminal_status: "completed",
      })
    }

    await writeRuntimeMetric("session-replay", { measurements })
  }, 120_000)

  test("cleans a failed blob stream so the model turn remains retryable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-stress-blob-"))
    try {
      const store = new BlobStore(root)
      async function* resetStream() {
        yield new TextEncoder().encode("partial model attachment")
        throw new Error("model stream reset")
      }

      let failure: unknown
      try {
        await store.put({ source: resetStream(), mime: "text/plain" })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ message: "model stream reset" })
      expect(await readdir(path.join(root, "blob", "sha256", ".tmp"))).toEqual([])
      expect({ terminal_status: "retryable", blob_temp_files: 0 }).toMatchObject({ terminal_status: "retryable" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
