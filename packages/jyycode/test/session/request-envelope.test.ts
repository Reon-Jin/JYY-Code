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

test("computer request envelopes record media identity without duplicating screenshot bytes", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 1024 }, (_, index) => index % 251)])
  const jpg = Buffer.from([255, 216, 255, ...Array.from({ length: 1024 }, (_, index) => (index * 7) % 251)])
  const pngBase64 = png.toString("base64")
  const jpgURL = `data:image/jpeg;base64,${jpg.toString("base64")}`
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", toolName: "computer", toolCallId: "call-1", input: {} }] },
    { role: "tool", content: [
      { type: "media", mediaType: "image/png", data: pngBase64 },
      { type: "image", image: jpgURL },
      { type: "image", image: new Uint8Array(png) },
    ] },
  ]
  const artifact = createRequestEnvelope({
    sessionID: "session-computer",
    stepID: "step-2",
    runtime: "ai-sdk",
    model: { providerID: "test", id: "test-model" } as never,
    prepared,
    messages,
  })
  const content = (artifact.envelope.messages[1] as { content: Array<Record<string, unknown>> }).content
  const record = { omitted: "request-envelope-media", mime: "image/png", bytes: png.byteLength, sha256: sha256(png) }
  expect(content[0]?.data).toEqual(record)
  expect(content[1]?.image).toEqual({ omitted: "request-envelope-media", mime: "image/jpeg", bytes: jpg.byteLength, sha256: sha256(jpg) })
  expect(content[2]?.image).toEqual(record)
  const saved = new TextDecoder().decode(artifact.bytes)
  expect(saved).not.toContain(pngBase64)
  expect(saved).not.toContain(jpgURL)
  expect(saved.length).toBeLessThan(2000)
  expect((messages[1]!.content[1] as { image: string }).image).toBe(jpgURL)
})

test("computer request envelopes cap unstructured large media strings", () => {
  const large = "x".repeat(64 * 1024)
  const messages = [{ role: "user", content: [{ type: "text", text: large }] }]
  const artifact = createRequestEnvelope({
    sessionID: "session-computer",
    stepID: "step-1",
    runtime: "ai-sdk",
    model: { providerID: "test", id: "test-model" } as never,
    prepared: {
      system: [], messages, tools: { computer: { description: "Computer control" } },
      params: { options: {} }, headers: {},
    } as never,
    messages,
  })
  const text = ((artifact.envelope.messages[0] as { content: Array<{ text: unknown }> }).content[0]!).text
  expect(text).toEqual({ omitted: "request-envelope-media", mime: "text/plain; charset=utf-8", bytes: 64 * 1024, sha256: sha256(large) })
  expect(artifact.bytes.byteLength).toBeLessThan(1000)
})
