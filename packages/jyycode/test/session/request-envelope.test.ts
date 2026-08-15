import { expect, test } from "bun:test"
import { createRequestEnvelope, sha256, stableJSON, stripTransportHeaders } from "../../src/session/request-envelope"
import { replaySecretFindings } from "../lib/replay/normalize"

const modelMessages = [{ role: "user", content: "hello" }]
const prepared = {
  system: ["You are a coding assistant."],
  messages: modelMessages,
  tools: {
    lookup: {
      description: "Look up information",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      execute: () => ({ output: "not persisted" }),
    },
  },
  params: {
    temperature: 0,
    topP: 1,
    topK: undefined,
    maxOutputTokens: 100,
    options: { response_format: { type: "text" } },
  },
  messageTransformOptions: {},
  headers: {
    Authorization: "Bearer should-not-persist",
    Cookie: "session=should-not-persist",
    "x-api-key": "should-not-persist",
    "x-session-affinity": "session-1",
  },
} as never

test("request envelopes are deterministic and reconstructable", () => {
  const artifact = createRequestEnvelope({
    sessionID: "session-1",
    stepID: "step-1",
    runtime: "ai-sdk",
    variant: "default",
    model: { providerID: "test", id: "test-model" } as never,
    prepared,
    messages: modelMessages,
  })

  expect(artifact.envelope.version).toBe(1)
  expect(artifact.envelope.messages).toEqual(modelMessages)
  expect(artifact.envelope.tools.lookup).toEqual({
    description: "Look up information",
    schema: { type: "object", properties: { query: { type: "string" } } },
  })
  expect(new TextDecoder().decode(artifact.bytes)).toBe(stableJSON(artifact.envelope))
  expect(artifact.sha256).toBe(sha256(artifact.bytes))
  expect(artifact.configHash).toMatch(/^[0-9a-f]{64}$/)
  expect(artifact.toolCatalogHash).toMatch(/^[0-9a-f]{64}$/)
})

test("request envelopes strip secret-bearing transport headers before persistence", () => {
  const headers = stripTransportHeaders({
    Authorization: "Bearer secret",
    Cookie: "sid=secret",
    "Set-Cookie": "sid=secret",
    "x-api-key": "secret",
    "x-session-affinity": "session-1",
    "User-Agent": "jyycode/test",
  })

  expect(headers).toEqual({
    "x-session-affinity": "session-1",
    "User-Agent": "jyycode/test",
  })
  expect(replaySecretFindings({ headers })).toEqual([])
})
