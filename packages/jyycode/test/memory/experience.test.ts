import { describe, expect, test } from "bun:test"
import { ExperienceMemory } from "@/memory/experience"
import type { SessionID } from "@/session/schema"

const sessionID = "ses_01JZEXPERIENCE1" as SessionID

function entry(overrides: Partial<ExperienceMemory.ExperienceEntry> = {}): ExperienceMemory.ExperienceEntry {
  return {
    scope: "experience",
    kind: "lesson",
    importance: 7,
    date: "20260807",
    updatedAt: "20260807",
    keywords: ["测试"],
    content: "先跑失败测试再实现，避免无效改动",
    evidence: "[ses_01JZEXPERIENCE1#3] npm test",
    confidence: "high",
    uses: 0,
    status: "active",
    sessionID,
    ...overrides,
  }
}

function rawEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { scope: _scope, ...rest } = { ...entry(), ...overrides }
  return rest
}

describe("experience v1 JSON format", () => {
  test("parses and round-trips a valid store deterministically", () => {
    const text = ExperienceMemory.serializeExperienceStore([entry()])
    expect(text).toBe(
      '{\n' +
        '  "schemaVersion": 1,\n' +
        '  "lastMaintainedAt": null,\n' +
        '  "entries": [\n' +
        '    {\n' +
        '      "kind": "lesson",\n' +
        '      "importance": 7,\n' +
        '      "date": "20260807",\n' +
        '      "updatedAt": "20260807",\n' +
        '      "keywords": [\n' +
        '        "测试"\n' +
        '      ],\n' +
        '      "content": "先跑失败测试再实现，避免无效改动",\n' +
        '      "evidence": "[ses_01JZEXPERIENCE1#3] npm test",\n' +
        '      "confidence": "high",\n' +
        '      "uses": 0,\n' +
        '      "status": "active",\n' +
        '      "sessionID": "ses_01JZEXPERIENCE1"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n',
    )
    expect(ExperienceMemory.serializeExperienceStore(ExperienceMemory.parseExperienceStore(text).entries)).toBe(text)
  })

  test("rejects invalid stores", () => {
    expect(() => ExperienceMemory.parseExperienceStore('{"schemaVersion":2,"lastMaintainedAt":null,"entries":[]}')).toThrow(
      "schemaVersion",
    )
    expect(() =>
      ExperienceMemory.parseExperienceStore(
        JSON.stringify({
          schemaVersion: 1,
          lastMaintainedAt: null,
          entries: [rawEntry({ kind: "unknown" })],
        }),
      ),
    ).toThrow("kind")
    expect(() =>
      ExperienceMemory.parseExperienceStore(
        JSON.stringify({
          schemaVersion: 1,
          lastMaintainedAt: null,
          entries: [rawEntry({ evidence: "no anchor" })],
        }),
      ),
    ).toThrow("evidence")
  })

  test("rejects duplicate content keys", () => {
    expect(() =>
      ExperienceMemory.parseExperienceStore(
        ExperienceMemory.serializeExperienceStore([entry(), entry({ importance: 9 })]),
      ),
    ).toThrow("duplicate key")
  })

  test("experienceKey is a stable content hash", () => {
    expect(ExperienceMemory.experienceKey(entry())).toBe(ExperienceMemory.experienceKey(entry({ importance: 3 })))
    expect(ExperienceMemory.experienceKey(entry())).not.toBe(
      ExperienceMemory.experienceKey(entry({ content: "完全不同的经验" })),
    )
  })

  test("localDate and dateNDaysAgo return YYYYMMDD strings", () => {
    expect(ExperienceMemory.localDate(new Date(2026, 7, 7))).toBe("20260807")
    expect(ExperienceMemory.dateNDaysAgo(0)).toMatch(/^\d{8}$/u)
  })
})
