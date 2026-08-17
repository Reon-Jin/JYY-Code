import { describe, expect, test } from "bun:test"
import {
  compactionToForm,
  validateCompaction,
  permissionPolicyLabel,
  formatConfigPath,
  type CompactionForm,
} from "../../../src/cli/cmd/tui/feature-plugins/system/settings"
import type { GlobalCompaction } from "@jyycode-ai/sdk/v2"

const compaction: GlobalCompaction = {
  auto: true,
  prune: false,
  tailTurns: 6,
  triggerRatio: 0.8,
  microCompact: true,
  microCompactMaxChars: 4000,
  reactiveCompact: true,
}

describe("settings logic", () => {
  test("compactionToForm 映射字段", () => {
    const form = compactionToForm(compaction)
    expect(form.auto).toBe(true)
    expect(form.triggerRatio).toBe(0.8)
    expect(form.tailTurns).toBe(6)
    expect(form.microCompact).toBe(true)
  })

  test("validateCompaction：非法输入报错，合法通过", () => {
    expect(validateCompaction({ auto: true, triggerRatio: 0, tailTurns: 6, microCompact: true, reactiveCompact: true })?.triggerRatio).toBeTruthy()
    expect(validateCompaction({ auto: true, triggerRatio: 1.5, tailTurns: 6, microCompact: true, reactiveCompact: true })?.triggerRatio).toBeTruthy()
    expect(validateCompaction({ auto: true, triggerRatio: 0.8, tailTurns: 0, microCompact: true, reactiveCompact: true })?.tailTurns).toBeTruthy()
    expect(validateCompaction({ auto: true, triggerRatio: 0.8, tailTurns: 2.5, microCompact: true, reactiveCompact: true })?.tailTurns).toBeTruthy()
    const valid: CompactionForm = { auto: true, triggerRatio: 0.8, tailTurns: 6, microCompact: true, reactiveCompact: true }
    expect(validateCompaction(valid)).toBeNull()
  })

  test("permission policy 标签", () => {
    expect(permissionPolicyLabel("auto")).toBe("auto（自动）")
    expect(permissionPolicyLabel("request")).toBe("request（请求确认）")
    expect(permissionPolicyLabel("full")).toBe("full（全部允许）")
    expect(permissionPolicyLabel("custom")).toBe("custom（自定义）")
    expect(permissionPolicyLabel("weird")).toBe("weird")
  })

  test("config 路径格式化", () => {
    expect(formatConfigPath("C:\\Users\\me\\.config\\jyycode")).toBe("C:\\Users\\me\\.config\\jyycode\\jyycode.jsonc")
    expect(formatConfigPath("/home/user/.config/jyycode/")).toBe("/home/user/.config/jyycode/jyycode.jsonc")
  })
})
