import { describe, expect, test } from "bun:test"
import {
  buildMcpForm,
  validateMcpForm,
  redactMcpSecret,
  mcpStatusLabel,
  mcpStatusSymbol,
  configSummary,
  type McpEntry,
} from "../../../src/cli/cmd/tui/feature-plugins/system/mcp-manage"

describe("mcp-manage form logic", () => {
  test("buildMcpForm 将远端配置映射为可编辑表单", () => {
    const form = buildMcpForm(
      { type: "local", command: ["npx", "-y", "mcp-server-fs"], environment: { A: "1" } },
      "fs",
    )
    expect(form.name).toBe("fs")
    expect(form.command).toBe("npx")
    expect(form.args).toEqual(["-y", "mcp-server-fs"])
    expect(form.environment).toEqual({ A: "1" })
    expect(form.enabled).toBe(true)
  })

  test("validateMcpForm 拒绝空名称/空命令", () => {
    expect(validateMcpForm({ name: "", command: "npx", args: [], environment: {}, enabled: true }).name).toBeTruthy()
    expect(
      validateMcpForm({ name: "x", command: "", args: [], environment: {}, enabled: true }).command,
    ).toBeTruthy()
    expect(validateMcpForm({ name: "x", command: "npx", args: [], environment: {}, enabled: true })).toEqual({})
  })

  test("redactMcpSecret 不展示已有 secret 明文", () => {
    expect(redactMcpSecret("super-secret").value).toBe("••••••••")
    expect(redactMcpSecret("super-secret").redacted).toBe(true)
    expect(redactMcpSecret("").value).toBe("")
    expect(redactMcpSecret("").redacted).toBe(false)
  })
})

describe("mcp-manage status mapping", () => {
  test("状态标签与符号", () => {
    expect(mcpStatusLabel({ status: "connected" })).toBe("connected")
    expect(mcpStatusLabel({ status: "failed", error: "boom" })).toBe("failed")
    expect(mcpStatusLabel(undefined)).toBe("unknown")
    expect(mcpStatusSymbol({ status: "connected" })).toBe("●")
    expect(mcpStatusSymbol({ status: "disabled" })).toBe("○")
    expect(mcpStatusSymbol({ status: "failed", error: "x" })).toBe("✕")
    expect(mcpStatusSymbol({ status: "needs_auth" })).toBe("▲")
  })

  test("configSummary 摘要", () => {
    expect(configSummary({ type: "local", command: ["npx", "-y", "x"] })).toBe("npx -y x")
    expect(configSummary({ type: "remote", url: "https://mcp.example.com/sse" })).toBe("https://mcp.example.com/sse")
  })
})

describe("mcp-manage entry typing", () => {
  test("McpEntry 可承载 status", () => {
    const entry: McpEntry = {
      name: "fs",
      config: { type: "local", command: ["npx"], enabled: false },
      status: { status: "disabled" },
    }
    expect(entry.name).toBe("fs")
    expect(entry.config.type).toBe("local")
    expect(entry.status?.status).toBe("disabled")
  })
})
