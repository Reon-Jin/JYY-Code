import { describe, expect, test } from "bun:test"

import { assertReplayValueFree, normalizeFixture, replaySecretFindings } from "./normalize"

describe("replay fixture normalization", () => {
  test("normalizes semantic paths, IDs, timestamps, ports, process IDs, and volatile metrics", () => {
    const fixture = {
      workspaceSeed: {
        windowsPath: String.raw`C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo`,
        unixPath: "/tmp/jyycode-test-456/repo",
      },
      sessionInput: {
        sessionID: "01JZQY7N8S8J7X8KQ5Z4N3P2M1",
        prompt: String.raw`Mention C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo only when it is part of the prompt`,
      },
      modelReplies: [
        { toolCallId: "call_01JZQY7N8S8J7X8KQ5Z4N3P2M1", timestamp: "2026-08-15T00:00:01.000Z" },
        { toolCallId: "call_01JZQY7N8S8J7X8KQ5Z4N3P2M1", timestamp: "2026-08-15T00:00:01.000Z" },
      ],
      expected: {
        requestEnvelopes: [{ url: "http://127.0.0.1:43127/v1", sessionID: "01JZQY7N8S8J7X8KQ5Z4N3P2M1" }],
        messages: [
          {
            path: String.raw`C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo\src\app.tsx`,
            callId: "call_01JZQY7N8S8J7X8KQ5Z4N3P2M1",
          },
        ],
        events: [{ pid: 9123, inputTokens: 12, outputTokens: 8, cost: 0.001, durationMs: 23 }],
        files: [],
      },
      terminalStatus: { endedAt: "2026-08-15T00:00:02.000Z" },
    }

    const normalized = normalizeFixture(fixture, {
      workspaceRoots: [
        String.raw`C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo`,
        "/tmp/jyycode-test-456/repo",
      ],
    })

    expect(normalized.workspaceSeed).toEqual({ windowsPath: "<workspace>", unixPath: "<workspace>" })
    expect(normalized.sessionInput).toEqual({ sessionID: "<session-1>", prompt: fixture.sessionInput.prompt })
    expect(normalized.modelReplies).toEqual([
      { toolCallId: "<call-1>", timestamp: "<timestamp-1>" },
      { toolCallId: "<call-1>", timestamp: "<timestamp-1>" },
    ])
    expect(normalized.expected.requestEnvelopes[0]).toMatchObject({
      url: "http://127.0.0.1:<port-1>/v1",
      sessionID: "<session-1>",
    })
    expect(normalized.expected.messages[0]).toMatchObject({ path: "<workspace>/src/app.tsx", callId: "<call-1>" })
    expect(normalized.expected.events[0]).toEqual({
      pid: "<pid-1>",
      inputTokens: "<tokens-1>",
      outputTokens: "<tokens-2>",
      cost: "<cost-1>",
      durationMs: "<duration-1>",
    })
    expect(normalized.terminalStatus).toEqual({ endedAt: "<timestamp-2>" })
  })

  test("does not replace path-like text in an ordinary prompt", () => {
    const value = { prompt: String.raw`C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo` }
    expect(
      normalizeFixture(value, {
        workspaceRoots: [String.raw`C:\Users\alice\AppData\Local\Temp\jyycode-test-123\repo`],
      }),
    ).toEqual(value)
  })

  test("rejects secret-bearing fields and secret-shaped values", () => {
    expect(replaySecretFindings({ headers: { authorization: "Bearer very-secret" } })).not.toHaveLength(0)
    expect(() => assertReplayValueFree({ provider: { apiKey: "do-not-record" } })).toThrow("secret-like")
    expect(() => assertReplayValueFree({ response: "sk-123456789012345678901234" })).toThrow("secret-like")
  })
})
