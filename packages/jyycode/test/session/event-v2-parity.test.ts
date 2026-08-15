import { expect, test } from "bun:test"
import * as DateTime from "effect/DateTime"
import { EventV2 } from "@jyycode-ai/core/event"
import { ModelV2 } from "@jyycode-ai/core/model"
import { ProviderV2 } from "@jyycode-ai/core/provider"
import { SessionEvent } from "@jyycode-ai/core/session-event"
import { SessionMessageUpdater } from "@jyycode-ai/core/session-message-updater"
import { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { normalizeEventMessages, parityDiff } from "../lib/replay/message-parity"

const sessionID = SessionID.make("session-parity")
const model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  variant: ModelV2.VariantID.make("default"),
}
const tokens = {
  input: 3,
  output: 2,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function id() {
  return EventV2.ID.create()
}

function legacyUser(text: string) {
  return {
    info: {
      id: "legacy-user",
      role: "user",
      sessionID,
      time: { created: 1 },
    },
    parts: [{ type: "text", id: "legacy-user-part", sessionID, messageID: "legacy-user", text }],
  } as unknown as MessageV2.WithParts
}

function legacyAssistant(parts: MessageV2.Part[]) {
  return {
    info: {
      id: "legacy-assistant",
      role: "assistant",
      sessionID,
      agent: "build",
      mode: "build",
      modelID: "test-model",
      providerID: "test",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens,
      time: { created: 2, completed: 4 },
      finish: "stop",
    },
    parts,
  } as unknown as MessageV2.WithParts
}

function project(events: readonly SessionEvent.Event[]) {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const adapter = SessionMessageUpdater.memory(state)
  for (const event of events) SessionMessageUpdater.update(adapter, event)
  return state.messages
}

test("normalizes text, reasoning, finish, usage, and time across legacy and EventV2", () => {
  const events = [
    {
      id: id(),
      type: "session.next.prompted",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        prompt: { text: "hello", files: [], agents: [], references: [] },
      },
    },
    {
      id: id(),
      type: "session.next.step.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2), agent: "build", model },
    },
    {
      id: id(),
      type: "session.next.reasoning.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2), reasoningID: "reason-1" },
    },
    {
      id: id(),
      type: "session.next.reasoning.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(3), reasoningID: "reason-1", text: "think" },
    },
    {
      id: id(),
      type: "session.next.text.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(3) },
    },
    {
      id: id(),
      type: "session.next.text.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(4), text: "answer" },
    },
    {
      id: id(),
      type: "session.next.step.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(5), finish: "stop", cost: 0, tokens },
    },
  ] as unknown as SessionEvent.Event[]

  const legacy = [
    legacyUser("hello"),
    legacyAssistant([
      {
        type: "reasoning",
        id: "legacy-reason" as never,
        sessionID,
        messageID: "legacy-assistant" as never,
        text: "think",
        time: { start: 2, end: 3 },
      },
      {
        type: "text",
        id: "legacy-text" as never,
        sessionID,
        messageID: "legacy-assistant" as never,
        text: "answer",
      },
    ]),
  ]
  const diff = parityDiff(legacy, project(events))
  expect(diff.equal).toBe(true)
  expect(diff.eventV2).toEqual(diff.legacy)
})

test("normalizes completed tool state and keeps explicit EventV2-only drops", () => {
  const events = [
    {
      id: id(),
      type: "session.next.agent.switched",
      data: { sessionID, timestamp: DateTime.makeUnsafe(1), agent: "build" },
    },
    {
      id: id(),
      type: "session.next.step.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2), agent: "build", model },
    },
    {
      id: id(),
      type: "session.next.tool.input.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2), callID: "call-1", name: "lookup" },
    },
    {
      id: id(),
      type: "session.next.tool.called",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        callID: "call-1",
        tool: "lookup",
        input: { query: "weather" },
        provider: { executed: false },
      },
    },
    {
      id: id(),
      type: "session.next.tool.success",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        callID: "call-1",
        structured: {},
        content: [{ type: "text", text: "sunny" }],
        provider: { executed: false },
      },
    },
    {
      id: id(),
      type: "session.next.step.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(5), finish: "stop", cost: 0, tokens },
    },
  ] as unknown as SessionEvent.Event[]

  const legacyTool = {
    id: "legacy-call",
    sessionID,
    messageID: "legacy-assistant",
    type: "tool",
    tool: "lookup",
    callID: "call-1",
    state: {
      status: "completed",
      input: { query: "weather" },
      output: "sunny",
      title: "Weather",
      metadata: {},
      time: { start: 2, end: 4 },
    },
  } as unknown as MessageV2.Part
  const diff = parityDiff([legacyAssistant([legacyTool])], project(events))

  expect(diff.equal).toBe(true)
  expect(diff.eventV2.map((message) => message.kind)).not.toContain("agent-switched")
})

test("replaying an EventV2 sequence through an idempotent event gate preserves the public projection", () => {
  const events = [
    {
      id: id(),
      type: "session.next.step.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(1), agent: "build", model },
    },
    {
      id: id(),
      type: "session.next.text.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2) },
    },
    {
      id: id(),
      type: "session.next.text.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(3), text: "once" },
    },
  ] as unknown as SessionEvent.Event[]
  const seen = new Set<string>()
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const adapter = SessionMessageUpdater.memory(state)
  const replay = () => {
    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      SessionMessageUpdater.update(adapter, event)
    }
    return normalizeEventMessages(state.messages)
  }

  const once = replay()
  const twice = replay()
  expect(twice).toEqual(once)
})
