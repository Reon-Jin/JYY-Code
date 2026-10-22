import type { LanguageModelUsage } from "ai"
import { Usage } from "@jyycode-ai/llm"
import type { Provider } from "@/provider/provider"
import { Session } from "./session"
import { MessageID, PartID, SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"

/** Persist auxiliary calls as hidden billed steps, without changing the chat's context window. */
export function auxiliaryUsagePart(input: {
  sessionID: SessionID
  messageID: MessageID
  reason: "memory-curation" | "memory-digest"
  model: Provider.Model
  usage: LanguageModelUsage
}): MessageV2.StepFinishPart {
  const billed = Session.getUsage({
    model: input.model,
    usage: new Usage({
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      totalTokens: input.usage.totalTokens,
      reasoningTokens: input.usage.outputTokenDetails?.reasoningTokens ?? input.usage.reasoningTokens,
      cacheReadInputTokens: input.usage.inputTokenDetails?.cacheReadTokens ?? input.usage.cachedInputTokens,
      cacheWriteInputTokens: input.usage.inputTokenDetails?.cacheWriteTokens,
    }),
  })
  return {
    id: PartID.ascending(),
    messageID: input.messageID,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: input.reason,
    ...billed,
  }
}
