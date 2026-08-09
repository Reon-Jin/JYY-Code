import { describe, expect, test } from "bun:test"
import { planSessionRepair, repairPlaceholder } from "@/session/session-repair"

describe("session repair plan", () => {
  test("keeps valid rows and turns corrupt rows into digest-only placeholders", () => {
    const plan = planSessionRepair({
      sourceSessionID: "ses_repair",
      rows: [
        { table: "message", id: "m1", data: '{"ok":true}' },
        { table: "part", id: "p1", data: "not-json" },
      ],
    })
    expect(plan.validRows).toHaveLength(1)
    expect(plan.corruptRows).toHaveLength(1)
    expect(plan.placeholders[0]?.sourceID).toBe("p1")
    expect(JSON.stringify(plan)).not.toContain("not-json")
    expect(repairPlaceholder(plan.corruptRows[0]!)).toMatchObject({ type: "repair-placeholder", table: "part", sourceID: "p1" })
  })
})
