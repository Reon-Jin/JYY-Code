import { describe, expect, test } from "bun:test"
import {
  groupByStatus,
  fileChangeSummary,
} from "../../../src/cli/cmd/tui/component/dialog-workspace-file-changes"
import type { VcsFileStatus } from "@jyycode-ai/sdk/v2"

const change = (overrides: Partial<VcsFileStatus>): VcsFileStatus => ({
  file: "a.ts",
  status: "modified",
  additions: 3,
  deletions: 1,
  ...overrides,
})

describe("changes panel logic", () => {
  test("groupByStatus 分组新增/修改/删除", () => {
    const changes = [
      change({ file: "a.ts", status: "added" }),
      change({ file: "b.ts", status: "modified" }),
      change({ file: "c.ts", status: "deleted" }),
      change({ file: "d.ts", status: "modified" }),
    ]
    const groups = groupByStatus(changes)
    expect(groups.added).toHaveLength(1)
    expect(groups.modified).toHaveLength(2)
    expect(groups.deleted).toHaveLength(1)
    expect(groupByStatus([]).added).toHaveLength(0)
  })

  test("fileChangeSummary 生成单行摘要", () => {
    expect(fileChangeSummary(change({ file: "src/a.ts", status: "modified", additions: 3, deletions: 1 }))).toContain(
      "+3",
    )
    expect(fileChangeSummary(change({ file: "x", status: "added", additions: 0, deletions: 0 }))).toBe("A x")
  })
})
