import { describe, expect, test } from "bun:test"
import { Memory } from "@/memory/memory"
import type { SessionID } from "@/session/schema"

const sessionID = "ses_01JZFCG3S4N6C5M7V8B9X0Y1Z2" as SessionID

describe("memory v3 JSON format", () => {
  test("parses valid task and user stores", () => {
    expect(
      Memory.parseStore(
        "memory",
        JSON.stringify({
          schemaVersion: 3,
          lastCompactedAt: null,
          entries: [
            {
              sessionID,
              importance: 3,
              date: "20260705",
              keywords: ["赛车游戏", "ts"],
              content: "完成赛车建模和地图绘制。",
            },
          ],
        }),
      ),
    ).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [
        {
          scope: "memory",
          sessionID,
          importance: 3,
          date: "20260705",
          keywords: ["赛车游戏", "ts"],
          content: "完成赛车建模和地图绘制。",
        },
      ],
    })

    expect(
      Memory.parseStore(
        "user",
        JSON.stringify({
          schemaVersion: 3,
          lastCompactedAt: null,
          entries: [{ importance: 10, keywords: ["生日"], content: "用户生日为20050218。" }],
        }),
      ),
    ).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [{ scope: "user", importance: 10, keywords: ["生日"], content: "用户生日为20050218。" }],
    })
  })

  test("serializes deterministically with two spaces and a trailing newline", () => {
    const text = Memory.serializeStore("user", [
      {
        scope: "user",
        importance: 9,
        keywords: [" ts ", "代码风格", "ts"],
        content: " 用户长期偏好 TypeScript。 ",
      },
    ])

    expect(text).toBe(
      '{\n  "schemaVersion": 3,\n  "lastCompactedAt": null,\n  "entries": [\n    {\n      "importance": 9,\n      "keywords": [\n        "ts",\n        "代码风格"\n      ],\n      "content": "用户长期偏好 TypeScript。"\n    }\n  ]\n}\n',
    )
    expect(Memory.serializeStore("user", Memory.parseStore("user", text).entries)).toBe(text)
  })

  test.each([
    [{ schemaVersion: 2, lastCompactedAt: null, entries: [] }, "schemaVersion"],
    [{ schemaVersion: 3, lastCompactedAt: null, entries: [], extra: true }, "unknown field"],
    [
      {
        schemaVersion: 3,
        lastCompactedAt: null,
        entries: [{ sessionID, importance: 11, date: "20260705", keywords: ["项目"], content: "完成项目。" }],
      },
      "importance",
    ],
    [
      {
        schemaVersion: 3,
        lastCompactedAt: null,
        entries: [{ sessionID, importance: 3, date: "20260230", keywords: ["赛车"], content: "完成赛车游戏。" }],
      },
      "date",
    ],
  ])("rejects invalid stores", (value, message) => {
    expect(() => Memory.parseStore("memory", JSON.stringify(value))).toThrow(message as string)
  })

  test("rejects duplicate stable keys", () => {
    expect(() =>
      Memory.parseStore(
        "user",
        JSON.stringify({
          schemaVersion: 3,
          lastCompactedAt: null,
          entries: [
            { importance: 7, keywords: [" ts "], content: "偏好 TypeScript。" },
            { importance: 8, keywords: ["ts"], content: "长期偏好 TypeScript。" },
          ],
        }),
      ),
    ).toThrow("duplicate key")
  })

  test("uses session IDs and normalized keywords as stable keys", () => {
    expect(
      Memory.entryKey({
        scope: "memory",
        importance: 4,
        date: "20260705",
        keywords: ["项目"],
        content: "完成项目基础设施。",
        sessionID,
      }),
    ).toBe(sessionID)
    expect(
      Memory.entryKey({
        scope: "user",
        importance: 8,
        keywords: [" ts ", "代码风格"],
        content: "用户偏好 TypeScript。",
      }),
    ).toBe("ts代码风格")
  })

  test("snapshot selection keeps only the current session task memory", () => {
    const mine: Memory.TaskMemoryEntry = {
      scope: "memory" as const,
      sessionID,
      importance: 3 as Memory.Importance,
      date: "20260705",
      keywords: ["任务"],
      content: "mine",
    }
    const other: Memory.TaskMemoryEntry = {
      scope: "memory" as const,
      sessionID: "ses_other" as SessionID,
      importance: 10 as Memory.Importance,
      date: "20260706",
      keywords: ["其他"],
      content: "other",
    }
    expect(Memory.selectSnapshotEntries([other, mine], "memory", sessionID).map((entry) => entry.content)).toEqual([
      "mine",
    ])
    const userEntry: Memory.UserMemoryEntry = {
      scope: "user" as const,
      importance: 9 as Memory.Importance,
      keywords: ["中文"],
      content: "偏好中文",
    }
    expect(Memory.selectSnapshotEntries([userEntry], "user", sessionID).map((entry) => entry.content)).toEqual([
      "偏好中文",
    ])
  })

  test("accepts only keywords containing 2 to 4 characters", () => {
    for (const keyword of ["编程", "代码风格", "ts"]) {
      expect(() =>
        Memory.serializeStore("user", [{ scope: "user", importance: 5, keywords: [keyword], content: "用户偏好。" }]),
      ).not.toThrow()
    }

    for (const keyword of ["a", "abcde", "五个字符啊"]) {
      expect(() =>
        Memory.serializeStore("user", [{ scope: "user", importance: 5, keywords: [keyword], content: "用户偏好。" }]),
      ).toThrow(/must be (?:at least 2|at most 4) characters/u)
    }
  })

  test("selectSnapshotEntries returns the current session entry keywords", () => {
    const entry: Memory.TaskMemoryEntry = {
      scope: "memory",
      sessionID,
      importance: 5,
      date: "20260807",
      keywords: ["修复"],
      content: "当前任务：修复；进展：完成",
    }
    const store = Memory.parseStore("memory", Memory.serializeStore("memory", [entry]))
    const selected = Memory.selectSnapshotEntries(store.entries, "memory", sessionID)
    expect(selected[0]?.keywords).toEqual(["修复"])
  })

  test("drops the legacy 下一步 segment when parsing task entries", () => {
    const text = JSON.stringify({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [
        {
          sessionID,
          importance: 5,
          date: "20260807",
          keywords: ["旧格式"],
          content: "当前任务：旧任务；进展：完成；下一步：等待用户新指令",
        },
      ],
    })
    const store = Memory.parseStore("memory", text)
    expect(store.entries[0]?.content).toBe("当前任务：旧任务；进展：完成")
  })
})
