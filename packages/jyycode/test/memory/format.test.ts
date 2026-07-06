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
              keywords: ["赛车游戏", "TypeScript"],
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
          keywords: ["赛车游戏", "typescript"],
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
        keywords: [" TypeScript ", "代码风格", "typescript"],
        content: " 用户长期偏好 TypeScript。 ",
      },
    ])

    expect(text).toBe(
      '{\n  "schemaVersion": 3,\n  "lastCompactedAt": null,\n  "entries": [\n    {\n      "importance": 9,\n      "keywords": [\n        "typescript",\n        "代码风格"\n      ],\n      "content": "用户长期偏好 TypeScript。"\n    }\n  ]\n}\n',
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
        entries: [
          { sessionID, importance: 11, date: "20260705", keywords: ["项目"], content: "完成项目。" },
        ],
      },
      "importance",
    ],
    [
      {
        schemaVersion: 3,
        lastCompactedAt: null,
        entries: [
          { sessionID, importance: 3, date: "20260230", keywords: ["赛车"], content: "完成赛车游戏。" },
        ],
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
            { importance: 7, keywords: [" TypeScript "], content: "偏好 TypeScript。" },
            { importance: 8, keywords: ["typescript"], content: "长期偏好 TypeScript。" },
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
        keywords: [" TypeScript ", "代码风格"],
        content: "用户偏好 TypeScript。",
      }),
    ).toBe("typescript\u001f代码风格")
  })
})
