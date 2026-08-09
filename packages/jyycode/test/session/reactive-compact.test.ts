import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { reactiveCompact } from "../../src/session/reactive-compact"
import type { MessageV2 } from "../../src/session/message-v2"

const sessionID = SessionID.make("ses_reactive_compact")

function user(text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: Date.now() },
    } as MessageV2.User,
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

function assistant(parts: MessageV2.Part[]): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      parentID: MessageID.ascending(),
      mode: "build",
      agent: "build",
      path: { cwd: "D:/jyycode", root: "D:/jyycode" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test",
      time: { created: Date.now() },
    } as MessageV2.Assistant,
    parts: parts.map((part) => ({ ...part, messageID: id })),
  }
}

function completed(tool: string, output: string): MessageV2.ToolPart {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID,
    type: "tool",
    tool,
    callID: `call-${tool}`,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  }
}

describe("reactive conversation compaction", () => {
  test("compresses old completed chains while preserving goals, plan state, and active calls", () => {
    const oldOutput = "x".repeat(12_000)
    const pending = {
      ...completed("shell", "pending"),
      state: { status: "running", input: {}, time: { start: Date.now() } },
    } as MessageV2.ToolPart
    const messages = [
      user("old user goal"),
      assistant([completed("shell", oldOutput), completed("Plan_update", "plan state")]),
      user("middle turn"),
      assistant([pending]),
      user("recent user goal: preserve this exact objective"),
    ]

    const result = reactiveCompact({ messages, config: { recentUserTurns: 2, maxToolOutputChars: 800 } })
    const oldAssistant = result.messages[1]!
    const oldTool = oldAssistant.parts.find(
      (part) => part.type === "tool" && part.tool === "shell",
    ) as MessageV2.ToolPart
    const plan = oldAssistant.parts.find(
      (part) => part.type === "tool" && part.tool === "Plan_update",
    ) as MessageV2.ToolPart
    const active = result.messages[3]!.parts[0] as MessageV2.ToolPart

    expect(result.stats.changed).toBe(true)
    expect(result.stats.compactedToolOutputs).toBe(1)
    expect(oldTool.state.status === "completed" && oldTool.state.output.length).toBeLessThan(oldOutput.length)
    expect(plan.state.status === "completed" && plan.state.output).toBe("plan state")
    expect(active.state.status).toBe("running")
    expect((result.messages[4]!.parts[0] as MessageV2.TextPart).text).toContain("recent user goal")
  })

  test("the feature flag can disable the transformation", () => {
    const messages = [user("goal"), assistant([completed("shell", "x".repeat(10_000))])]
    const result = reactiveCompact({ messages, config: { enabled: false } })
    expect(result.stats.changed).toBe(false)
    expect(result.messages).toEqual(messages)
  })
})
