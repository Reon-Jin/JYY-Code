import * as Log from "@jyycode-ai/core/util/log"
import { buildObservationPrompt, buildObserverInitPrompt, buildObserverContinuationPrompt, parseObserverResponse, type ParsedObservation } from "./observer-prompt"
import { MemoryDb, type ObservationInput } from "./memory-db"

const log = Log.create({ service: "memory-observer" })

export type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>

export interface ObserverConfig {
  db: MemoryDb
  llmCall: LlmCallFn
  sessionId: string
  project?: string
}

const MAX_OBSERVATIONS_PER_RUN = 5

export class MemoryObserver {
  private db: MemoryDb
  private llmCall: LlmCallFn
  private sessionId: string
  private project: string
  private initialized: boolean = false
  private lastSummaryTime: number = 0
  private turnCount: number = 0

  constructor(config: ObserverConfig) {
    this.db = config.db
    this.llmCall = config.llmCall
    this.sessionId = config.sessionId
    this.project = config.project ?? "jyycode"
  }

  async observeToolCall(opts: {
    toolName: string
    toolInput: unknown
    toolOutput: unknown
    timestamp?: number
    cwd?: string
  }): Promise<ParsedObservation[]> {
    try {
      const prompt = buildObservationPrompt({
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        toolOutput: opts.toolOutput,
        timestamp: opts.timestamp ?? Date.now(),
        cwd: opts.cwd,
      })
      const response = await this.llmCall("", prompt)
      const observations = parseObserverResponse(response)

      for (const obs of observations.slice(0, MAX_OBSERVATIONS_PER_RUN)) {
        this.storeObservation(obs)
      }

      if (observations.length > 0) {
        log.debug("observer extracted observations", {
          sessionId: this.sessionId,
          toolName: opts.toolName,
          count: observations.length,
          types: observations.map((o) => o.type),
        })
      }

      return observations
    } catch (err) {
      log.warn("observer tool call failed", { toolName: opts.toolName, error: String(err) })
      return []
    }
  }

  async observeTurn(userRequest: string, _assistantResponse: string): Promise<ParsedObservation[]> {
    try {
      const prompt = this.initialized
        ? buildObserverContinuationPrompt(userRequest)
        : buildObserverInitPrompt(this.project).replace("{user_request}", userRequest).replace("{today}", new Date().toISOString().split("T")[0])

      const response = await this.llmCall("", prompt)
      const observations = parseObserverResponse(response)

      for (const obs of observations.slice(0, MAX_OBSERVATIONS_PER_RUN)) {
        this.storeObservation(obs)
      }
      this.initialized = true
      this.turnCount++

      if (observations.length > 0) {
        log.debug("observer turn extraction", {
          sessionId: this.sessionId,
          turnCount: this.turnCount,
          count: observations.length,
        })
      }

      return observations
    } catch (err) {
      log.warn("observer turn failed", { sessionId: this.sessionId, error: String(err) })
      return []
    }
  }

  shouldSummarize(minIntervalMs: number = 300_000): boolean {
    const now = Date.now()
    if (now - this.lastSummaryTime < minIntervalMs) return false
    return this.turnCount > 0
  }

  markSummarized(): void {
    this.lastSummaryTime = Date.now()
  }

  private storeObservation(obs: ParsedObservation): void {
    const input: ObservationInput = {
      memory_session_id: this.sessionId,
      kind: "observation",
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: obs.facts,
      concepts: obs.concepts,
      narrative: obs.narrative,
      files_read: obs.files_read,
      files_modified: obs.files_modified,
      generated_by_model: "observer",
      discovery_tokens: 0,
    }
    const result = this.db.createObservation(input)
    if (result) {
      log.debug("stored observation", { id: result.id, type: obs.type, title: obs.title?.slice(0, 40) })
    }
  }
}
