import * as Log from "@jyycode-ai/core/util/log"
import { parseSummaryResponse } from "./observer-prompt"
import { MemoryDb, type SummaryInput } from "./memory-db"
import type { LlmCallFn } from "./memory-observer"

const log = Log.create({ service: "memory-summarizer" })

const SUMMARY_MODE_MARKER = "MODE SWITCH: PROGRESS SUMMARY"

export interface SummarizerConfig {
  db: MemoryDb
  llmCall: LlmCallFn
  sessionId: string
  project?: string
}

function buildSummaryPrompt(lastAssistantMessage: string): { system: string; user: string } {
  return {
    system: `You are a session summarizer for JYYCode. Summarize what happened in this session.

Return your ENTIRE response wrapped in <summary>...</summary> tags.

<summary>
  <request>What the user asked for — the core task or question</request>
  <investigated>What was investigated, researched, or explored to complete the task</investigated>
  <learned>Key discoveries, insights, or knowledge gained during the session</learned>
  <completed>What was accomplished, built, or resolved</completed>
  <next_steps>What remains to be done, next actions, or follow-up items</next_steps>
  <notes>Any additional notes, warnings, or context for future sessions</notes>
</summary>

REMINDER: Your response MUST use <summary> as the root tag. No other format is accepted.`,
    user: `--- ${SUMMARY_MODE_MARKER} ---

Summarize the work that just happened in this session.

Here is the assistant's last response for context:

${lastAssistantMessage || "(no assistant response available)"}

Return your summary in the <summary> format specified.`,
  }
}

export class MemorySummarizer {
  private db: MemoryDb
  private llmCall: LlmCallFn
  private sessionId: string
  private project: string

  constructor(config: SummarizerConfig) {
    this.db = config.db
    this.llmCall = config.llmCall
    this.sessionId = config.sessionId
    this.project = config.project ?? "jyycode"
  }

  async summarize(lastAssistantMessage: string): Promise<{
    request: string | null
    investigated: string | null
    learned: string | null
    completed: string | null
    nextSteps: string | null
    notes: string | null
  } | null> {
    try {
      const { system, user } = buildSummaryPrompt(lastAssistantMessage)
      const response = await this.llmCall(system, user)
      const parsed = parseSummaryResponse(response)

      if (!parsed) {
        log.debug("summarizer returned no valid summary", { sessionId: this.sessionId })
        return null
      }

      const input: SummaryInput = {
        memory_session_id: this.sessionId,
        project: this.project,
        request: parsed.request,
        investigated: parsed.investigated,
        learned: parsed.learned,
        completed: parsed.completed,
        next_steps: parsed.next_steps,
        notes: parsed.notes,
      }

      const result = this.db.createSummary(input)
      log.info("summary stored", {
        sessionId: this.sessionId,
        summaryId: result.id,
        request: parsed.request?.slice(0, 80),
      })

      return {
        request: parsed.request,
        investigated: parsed.investigated,
        learned: parsed.learned,
        completed: parsed.completed,
        nextSteps: parsed.next_steps,
        notes: parsed.notes,
      }
    } catch (err) {
      log.warn("summarizer failed", { sessionId: this.sessionId, error: String(err) })
      return null
    }
  }
}
