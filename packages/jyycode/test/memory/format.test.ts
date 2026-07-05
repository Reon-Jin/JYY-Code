import { describe, expect, test } from "bun:test"
import { Memory } from "@/memory/memory"
import type { SessionID } from "@/session/schema"

const sessionID = "ses_01JZFCG3S4N6C5M7V8B9X0Y1Z2" as SessionID

describe("memory v2 entry format", () => {
  test("parses valid task and user entries", () => {
    expect(
      Memory.parseEntry(
        "memory",
        `- 重要性：3 + 日期：20260705 + 关键词：赛车游戏、TypeScript + 内容：完成赛车建模和地图绘制。 + session：${sessionID}`,
      ),
    ).toEqual({
      scope: "memory",
      importance: 3,
      date: "20260705",
      keywords: ["赛车游戏", "typescript"],
      content: "完成赛车建模和地图绘制。",
      sessionID,
    })

    expect(Memory.parseEntry("user", "- 重要性：10 + 关键词：生日 + 内容：用户生日为20050218。")).toEqual({
      scope: "user",
      importance: 10,
      keywords: ["生日"],
      content: "用户生日为20050218。",
    })
  })

  test("rejects fields in the wrong order", () => {
    expect(() =>
      Memory.parseEntry(
        "memory",
        `- 日期：20260705 + 重要性：3 + 关键词：赛车游戏 + 内容：完成赛车游戏。 + session：${sessionID}`,
      ),
    ).toThrow("Invalid memory entry format")
  })

  test("rejects importance outside 1 through 10", () => {
    expect(() => Memory.parseEntry("user", "- 重要性：11 + 关键词：姓名 + 内容：用户姓名为金毅阳。")).toThrow(
      "importance",
    )
  })

  test("rejects invalid calendar dates", () => {
    expect(() =>
      Memory.parseEntry(
        "memory",
        `- 重要性：3 + 日期：20260230 + 关键词：赛车游戏 + 内容：完成赛车游戏。 + session：${sessionID}`,
      ),
    ).toThrow("date")
  })

  test("rejects empty keywords", () => {
    expect(() => Memory.parseEntry("user", "- 重要性：8 + 关键词：　 + 内容：偏好简洁回答。")).toThrow(
      "keywords",
    )
  })

  test("preserves plus signs in content", () => {
    const entry = Memory.parseEntry(
      "memory",
      `- 重要性：7 + 日期：20260705 + 关键词：C++ + 内容：完成 C++ 与 A + B 解析支持。 + session：${sessionID}`,
    )
    expect(entry.content).toBe("完成 C++ 与 A + B 解析支持。")
  })

  test("serializes deterministically and round trips", () => {
    const entry: Memory.UserMemoryEntry = {
      scope: "user",
      importance: 9,
      keywords: [" TypeScript ", "代码风格", "typescript"],
      content: " 用户长期偏好 TypeScript。 ",
    }
    const serialized = Memory.serializeEntry(entry)

    expect(serialized).toBe("- 重要性：9 + 关键词：typescript、代码风格 + 内容：用户长期偏好 TypeScript。")
    expect(Memory.serializeEntry(Memory.parseEntry("user", serialized))).toBe(serialized)
  })

  test("uses session IDs and normalized keywords as stable keys", () => {
    const task: Memory.TaskMemoryEntry = {
      scope: "memory",
      importance: 4,
      date: "20260705",
      keywords: ["项目"],
      content: "完成项目基础设施。",
      sessionID,
    }
    const user: Memory.UserMemoryEntry = {
      scope: "user",
      importance: 8,
      keywords: [" TypeScript ", "代码风格"],
      content: "用户偏好 TypeScript。",
    }

    expect(Memory.entryKey(task)).toBe(sessionID)
    expect(Memory.entryKey(user)).toBe("typescript\u001f代码风格")
  })
})
