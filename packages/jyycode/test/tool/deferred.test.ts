import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Bus } from "@/bus"
import { MessageID, SessionID } from "@/session/schema"
import { ToolDisclosure } from "@/tool/disclosure"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const Params = Schema.Struct({ value: Schema.String })
const it = testEffect(Bus.layer)

function hiddenTool(): Tool.Def<typeof Params> {
  return {
    id: "send_message",
    description: "Send a message",
    parameters: Params,
    catalog: { category: "communication", mutability: "external", risk: "medium" },
    execute: (args) => Effect.succeed({ title: "Sent", output: args.value, metadata: {} }),
  }
}

function fakeContext(callID: string): Tool.Context {
  return {
    sessionID: SessionID.make("ses_deferred_tool"),
    messageID: MessageID.make("msg_deferred_tool"),
    callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool_exec", () => {
  it.instance("executes hidden tools by id", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const exec = ToolDisclosure.toolExecDef({
        hidden: [hiddenTool()],
        directIDs: new Set(["read"]),
        bus,
      })

      const result = yield* exec.execute(
        { tool: "send_message", args: { value: "hello" } },
        fakeContext("call_exec"),
      )

      expect(result.output).toBe("hello")
      expect(result.metadata).toMatchObject({ delegatedTool: "send_message" })
    }),
  )

  it.instance("does not execute direct tools", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const exec = ToolDisclosure.toolExecDef({
        hidden: [hiddenTool()],
        directIDs: new Set(["read"]),
        bus,
      })

      const effect = exec.execute({ tool: "read", args: {} }, fakeContext("call_direct"))

      yield* Effect.flip(effect).pipe(
        Effect.map((error) => expect(String(error)).toContain("not available through tool_exec")),
      )
    }),
  )
})
