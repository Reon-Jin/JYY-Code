import { describe, expect, test } from "bun:test"
import {
  workspaceStatusLabel,
  workspaceStatusSymbol,
  type WorkspaceStatus,
} from "../../../src/cli/cmd/tui/feature-plugins/system/workspace-manage"

describe("workspace manage logic", () => {
  test("状态标签映射", () => {
    expect(workspaceStatusLabel("connected")).toBe("已连接")
    expect(workspaceStatusLabel("connecting")).toBe("连接中")
    expect(workspaceStatusLabel("disconnected")).toBe("未连接")
    expect(workspaceStatusLabel("error")).toBe("错误")
  })

  test("状态符号映射", () => {
    expect(workspaceStatusSymbol("connected")).toBe("●")
    expect(workspaceStatusSymbol("connecting")).toBe("◌")
    expect(workspaceStatusSymbol("disconnected")).toBe("○")
    expect(workspaceStatusSymbol("error")).toBe("✕")
  })

  test("状态枚举完整", () => {
    const all: WorkspaceStatus[] = ["connected", "connecting", "disconnected", "error"]
    expect(all).toHaveLength(4)
  })
})
