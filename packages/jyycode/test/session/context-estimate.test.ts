import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { estimateContextTokens } from "../../src/session/context-estimate"
import type { MessageV2 } from "../../src/session/message-v2"

const sessionID = SessionID.make("ses_context_estimate")
const messageID = MessageID.ascending()

function user(parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: messageID,
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: Date.now() },
    } as MessageV2.User,
    parts,
  }
}

describe("estimateContextTokens", () => {
  test("estimates text with the existing chars-per-token heuristic", () => {
    const result = estimateContextTokens({
      messages: [
        user([
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "text",
            text: "x".repeat(4000),
          },
        ]),
      ],
    })

    expect(result.textTokens).toBe(1000)
    expect(result.totalTokens).toBeGreaterThanOrEqual(1000)
  })

  test("does not count base64 PDF bytes as text tokens", () => {
    const pdfData = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64")
    const result = estimateContextTokens({
      messages: [
        user([
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "file",
            mime: "application/pdf",
            filename: "sample.pdf",
            url: `data:application/pdf;base64,${pdfData}`,
          },
        ]),
      ],
    })

    expect(result.textTokens).toBeLessThan(100)
    expect(result.mediaBytes).toBe(2 * 1024 * 1024)
    expect(result.mediaTokens).toBeLessThan(50_000)
    expect(result.totalTokens).toBe(result.textTokens + result.toolTokens + result.mediaTokens + result.overheadTokens)
  })

  test("counts completed tool output as tool tokens", () => {
    const result = estimateContextTokens({
      messages: [
        {
          info: {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            parentID: messageID,
            mode: "build",
            agent: "build",
            path: { cwd: "D:/jyycode", root: "D:/jyycode" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test",
            time: { created: Date.now() },
          } as MessageV2.Assistant,
          parts: [
            {
              id: PartID.ascending(),
              messageID: MessageID.ascending(),
              sessionID,
              type: "tool",
              tool: "read",
              callID: "call-1",
              state: {
                status: "completed",
                input: {},
                output: "y".repeat(8000),
                title: "Read",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ],
        },
      ],
    })

    expect(result.toolTokens).toBe(2000)
  })

  test("counts the complete request budget, including system, schemas, arguments, injection, and reserve", () => {
    const result = estimateContextTokens({
      messages: [
        user([
          {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "tool",
            tool: "search",
            callID: "call-budget",
            state: {
              status: "completed",
              input: { query: "needle" },
              output: "result",
              title: "Search",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          },
        ]),
      ],
      system: ["system instructions"],
      tools: {
        search: {
          description: "Search for a value",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      },
      injectedContext: ["<memory>durable context</memory>"],
      outputReserve: 512,
    })

    expect(result.systemTokens).toBeGreaterThan(0)
    expect(result.injectedTokens).toBeGreaterThan(0)
    expect(result.toolSchemaTokens).toBeGreaterThan(0)
    expect(result.toolArgumentTokens).toBeGreaterThan(0)
    expect(result.outputReserve).toBe(512)
    expect(result.safetyMarginTokens).toBeGreaterThan(0)
    expect(result.totalTokens).toBe(result.inputTokens + result.outputReserve)
  })
})
