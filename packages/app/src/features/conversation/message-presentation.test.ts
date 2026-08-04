import { describe, expect, it } from "vitest"
import type { Message, Part } from "@jyycode-ai/sdk/v2/client"
import { presentConversationMessages, presentMessageText } from "./message-presentation"

describe("presentMessageText", () => {
  it("hides synthetic orchestration prompts", () => {
    expect(
      presentMessageText({
        part: { text: "=== CURRENT TURN SCOPE ===", synthetic: true },
        role: "user",
      }),
    ).toEqual({ kind: "hidden" })
  })

  it("keeps JSON-shaped assistant text visible instead of treating it as protocol state", () => {
    const plan = '准备计划\n```json\n{"goal":"Ship","tasks":[]}\n```'
    expect(presentMessageText({ part: { text: plan }, role: "assistant", agent: "build" })).toEqual({
      kind: "text",
      text: plan,
    })
  })
})

describe("presentConversationMessages", () => {
  const sessionID = "ses_present"
  const assistant = {
    id: "msg_assistant",
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_user",
    modelID: "gpt-5",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: { cwd: "D:\\code", root: "D:\\code" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as Message

  it("drops synthetic-only messages and consolidates consecutive assistant activity", () => {
    const synthetic: Part = {
      id: "part_synthetic",
      sessionID,
      messageID: "msg_user",
      type: "text",
      text: "internal",
      synthetic: true,
    }
    const reasoning: Part = {
      id: "part_reasoning",
      sessionID,
      messageID: assistant.id,
      type: "reasoning",
      text: "thinking",
      time: { start: 1, end: 2 },
    }
    const answer: Part = {
      id: "part_answer",
      sessionID,
      messageID: "msg_assistant_2",
      type: "text",
      text: "done",
    }

    const result = presentConversationMessages([
      { info: { id: "msg_user", sessionID, role: "user", time: { created: 0 } } as Message, parts: [synthetic] },
      { info: assistant, parts: [reasoning] },
      { info: { ...assistant, id: "msg_assistant_2" }, parts: [answer] },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.groups).toEqual([
      { type: "activity", parts: [reasoning] },
      { type: "content", parts: [answer] },
    ])
  })

  it("keeps activity groups on each side of visible content", () => {
    const firstReasoning = {
      id: "part_reasoning_1",
      sessionID,
      messageID: assistant.id,
      type: "reasoning",
      text: "first",
      time: { start: 1 },
    } as Part
    const answer = {
      id: "part_answer_middle",
      sessionID,
      messageID: assistant.id,
      type: "text",
      text: "middle answer",
    } as Part
    const secondReasoning = {
      id: "part_reasoning_2",
      sessionID,
      messageID: assistant.id,
      type: "reasoning",
      text: "second",
      time: { start: 2 },
    } as Part

    expect(
      presentConversationMessages([{ info: assistant, parts: [firstReasoning, answer, secondReasoning] }])[0]?.groups,
    ).toEqual([
      { type: "activity", parts: [firstReasoning] },
      { type: "content", parts: [answer] },
      { type: "activity", parts: [secondReasoning] },
    ])
  })

  it("hides internal patch metadata from conversation messages", () => {
    const patch: Part = {
      id: "part_patch",
      sessionID,
      messageID: assistant.id,
      type: "patch",
      hash: "abc123",
      files: ["D:/jyycode/.jyycode/plan/ses_1/plan.json"],
    }
    const answer: Part = {
      id: "part_answer",
      sessionID,
      messageID: assistant.id,
      type: "text",
      text: "done",
    }

    const result = presentConversationMessages([{ info: assistant, parts: [patch, answer] }])

    expect(result[0]?.groups).toEqual([{ type: "content", parts: [answer] }])
  })
})
