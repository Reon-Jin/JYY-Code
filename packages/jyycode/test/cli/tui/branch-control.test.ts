import { describe, expect, test } from "bun:test"
import { branchLabel, needsConfirmation } from "../../../src/cli/cmd/tui/feature-plugins/system/branch-control"

describe("branch control logic", () => {
  test("branchLabel 显示当前分支标记", () => {
    expect(branchLabel("main", "main")).toContain("*")
    expect(branchLabel("main", "main")).toBe("* main")
    expect(branchLabel("dev", "main")).toBe("  dev")
  })

  test("切换前工作区脏则需确认", () => {
    expect(needsConfirmation({ dirty: true })).toBe(true)
    expect(needsConfirmation({ dirty: false })).toBe(false)
  })
})
