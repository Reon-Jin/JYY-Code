import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []
const sessionID = SessionID.make("ses_snapshot")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("session snapshots", () => {
  test("contains only the current session task entry and the top user entries", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-"))
    cleanup.push(directory)
    const entries = Array.from(
      { length: 15 },
      (_, index): Memory.TaskMemoryEntry => ({
        scope: "memory",
        sessionID: SessionID.make(index === 0 ? "ses_snapshot" : `ses_snapshot_${index}`),
        importance: (index < 10 ? 10 : 1) as Memory.Importance,
        date: `202607${String((index % 6) + 1).padStart(2, "0")}`,
        keywords: [`条目${index}`],
        content: `当前任务：任务${index}；进展：完成`,
      }),
    )
    await fs.writeFile(path.join(directory, "MEMORY.json"), Memory.serializeStore("memory", entries))
    const userEntries = Array.from(
      { length: 15 },
      (_, index): Memory.UserMemoryEntry => ({
        scope: "user",
        importance: (index < 10 ? 10 : 1) as Memory.Importance,
        keywords: [`偏好${index}`],
        content: `用户偏好 ${index}。`,
      }),
    )
    await fs.writeFile(path.join(directory, "USER.json"), Memory.serializeStore("user", userEntries))
    const sessions = Layer.mock(Session.Service)({
      get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
      messages: () => Effect.succeed([]),
    })
    const layer = Memory.layerWithDirectory(directory).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
    )
    const snapshots = await Effect.runPromise(
      Memory.Service.use((memory) =>
        Effect.all([
          memory.formatWithHeader(sessionID, "memory"),
          memory.formatWithHeader(sessionID, "user"),
          memory.currentTaskKeywords(sessionID),
        ]),
      ).pipe(Effect.provide(layer)),
    )

    expect(snapshots[0].split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(1)
    expect(snapshots[0]).toContain("任务0")
    expect(snapshots[0]).not.toContain("任务1")
    expect(snapshots[1].split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(10)
    expect(snapshots[2]).toEqual(["条目0"])
  })

  test("user snapshot is capped by USER_SNAPSHOT_MAX_CHARS", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-cap-"))
    cleanup.push(directory)
    const userEntries = Array.from(
      { length: 10 },
      (_, index): Memory.UserMemoryEntry => ({
        scope: "user",
        importance: 10,
        keywords: [`偏好${index}`],
        content: `用户长期偏好非常详细的第 ${index} 条事实描述，用于测试截断逻辑。`,
      }),
    )
    await fs.writeFile(path.join(directory, "USER.json"), Memory.serializeStore("user", userEntries))
    const sessions = Layer.mock(Session.Service)({
      get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
      messages: () => Effect.succeed([]),
    })
    const layer = Memory.layerWithDirectory(directory).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
    )
    const snapshot = await Effect.runPromise(
      Memory.Service.use((memory) => memory.formatWithHeader(sessionID, "user")).pipe(Effect.provide(layer)),
    )
    expect(snapshot.length).toBeLessThanOrEqual(1_300)
  })

  test("shows the current session task first and project peers as read-only context", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-peers-"))
    cleanup.push(directory)
    const entries: Memory.TaskMemoryEntry[] = [
      {
        scope: "memory",
        sessionID: SessionID.make("ses_peer"),
        projectID: "proj_x" as Session.Info["projectID"],
        importance: 10,
        date: "20260720",
        keywords: ["其他"],
        content: "当前任务：其他会话任务；进展：完成",
      },
      {
        scope: "memory",
        sessionID,
        projectID: "proj_x" as Session.Info["projectID"],
        importance: 5,
        date: "20260701",
        keywords: ["自己"],
        content: "当前任务：本会话任务；进展：进行中",
      },
      {
        scope: "memory",
        sessionID: SessionID.make("ses_foreign"),
        projectID: "proj_y" as Session.Info["projectID"],
        importance: 10,
        date: "20260720",
        keywords: ["外部"],
        content: "当前任务：别的项目任务；进展：完成",
      },
    ]
    await fs.writeFile(path.join(directory, "MEMORY.json"), Memory.serializeStore("memory", entries))
    const sessions = Layer.mock(Session.Service)({
      get: (id) =>
        Effect.succeed({
          id,
          parentID: undefined,
          projectID: "proj_x" as Session.Info["projectID"],
        } as Session.Info),
      messages: () => Effect.succeed([]),
    })
    const layer = Memory.layerWithDirectory(directory).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
    )
    const snapshot = await Effect.runPromise(
      Memory.Service.use((memory) => memory.formatWithHeader(sessionID, "memory")).pipe(Effect.provide(layer)),
    )

    expect(snapshot).toContain("owner=self")
    expect(snapshot).toContain("owner=peer")
    expect(snapshot).toContain("本会话任务")
    expect(snapshot).toContain("其它会话任务：其他会话任务")
    expect(snapshot).not.toContain("当前任务：其他会话任务")
    expect(snapshot).not.toContain("别的项目任务")
    expect(snapshot.indexOf("本会话任务")).toBeLessThan(snapshot.indexOf("其他会话任务"))
  })
})
