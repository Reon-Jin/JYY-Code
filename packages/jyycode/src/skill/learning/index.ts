/**
 * Skill learning system — automatically observes user behavior patterns,
 * analyzes them to extract reusable skills and agent definitions, and
 * generates SKILL.md / agent files.
 *
 * Main service orchestrating observation → analysis → generation.
 *
 * Ported from claudecode's src/services/skillLearning/ infrastructure.
 */
import { Effect, Layer, Context } from "effect"
import { type SkillObservation, type InstinctCandidate, MAX_CANDIDATES_PER_ANALYSIS } from "./types"
import { Service as ObsService, defaultLayer as ObsLayer } from "./observation"
import { Service as GenService, defaultLayer as GenLayer } from "./generator"

export interface Interface {
  /** Record a tool event that may indicate a learnable pattern. */
  readonly observeToolEvent: (event: {
    toolName: string
    toolInput?: Record<string, unknown>
    sessionId?: string
    pattern: string
    context: string
  }) => Effect.Effect<void>
  /** Analyze pending observations and generate skills if confidence exceeds threshold. */
  readonly analyzeAndGenerate: (options?: {
    scope?: "project" | "global"
    dryRun?: boolean
  }) => Effect.Effect<{
    skillsGenerated: number
    agentsGenerated: number
    drafts: string[]
  }>
  /** Get learning statistics. */
  readonly stats: () => Effect.Effect<{
    pendingObservations: number
    totalRecorded: number
  }>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SkillLearning") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const observations = yield* ObsService
    const generator = yield* GenService

    const observeToolEvent = Effect.fn("SkillLearning.observeToolEvent")(function* (event: {
      toolName: string
      toolInput?: Record<string, unknown>
      sessionId?: string
      pattern: string
      context: string
    }) {
      yield* observations.recordToolEvent(event)
    })

    // Simple heuristic analyzer (no LLM dependency for basic operation).
    // Groups observations by tool name and creates instinct candidates.
    const analyzeHeuristic = Effect.fn("SkillLearning.analyzeHeuristic")(function* () {
      const pending = yield* observations.getPending()
      if (pending.length < 3) return [] as InstinctCandidate[]

      // Group by tool name
      const byTool = new Map<string, SkillObservation[]>()
      for (const obs of pending) {
        const key = obs.toolName ?? "session"
        if (!byTool.has(key)) byTool.set(key, [])
        byTool.get(key)!.push(obs)
      }

      const candidates: InstinctCandidate[] = []
      for (const [toolName, group] of byTool) {
        if (group.length < 2) continue

        // Find common patterns
        const patterns = group.map((o) => o.pattern)
        const avgConfidence = group.reduce((s, o) => s + o.confidence, 0) / group.length

        if (avgConfidence < 0.5) continue

        candidates.push({
          domain: group[0]?.domain ?? "project",
          pattern: patterns[0] ?? "",
          description: `Repeated ${toolName} usage pattern: ${patterns[0]}`,
          trigger: `When working with ${toolName}`,
          action: patterns.join("; "),
          confidence: avgConfidence,
        })
      }

      return candidates.slice(0, MAX_CANDIDATES_PER_ANALYSIS)
    })

    const analyzeAndGenerate = Effect.fn("SkillLearning.analyzeAndGenerate")(function* (options?: {
      scope?: "project" | "global"
      dryRun?: boolean
    }) {
      const scope = options?.scope ?? "project"
      const dryRun = options?.dryRun ?? false
      const drafts: string[] = []
      let skillsGenerated = 0
      let agentsGenerated = 0

      const candidates = yield* analyzeHeuristic()
      if (candidates.length === 0) {
        return { skillsGenerated: 0, agentsGenerated: 0, drafts: [] }
      }

      // Convert candidates to instincts for the generator
      const { type Instinct } = await import("./types")
      // Use inline type to avoid circular import
      const instincts = candidates.map((c, i) => ({
        id: `instinct_${Date.now()}_${i}`,
        domain: c.domain,
        pattern: c.pattern,
        description: c.description,
        confidence: c.confidence,
        evidence: [],
        status: "candidate" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }))

      // Try generating a skill
      const skillDraft = yield* generator.generateSkillDraft(instincts, scope)
      if (skillDraft && !dryRun) {
        const filePath = yield* generator.writeSkill(skillDraft)
        drafts.push(filePath)
        skillsGenerated++
      }

      // Try generating an agent if there are enough observations
      if (instincts.length >= 2) {
        const agentDraft = yield* generator.generateAgentDraft(instincts, scope)
        if (agentDraft && !dryRun) {
          const filePath = yield* generator.writeAgent(agentDraft)
          drafts.push(filePath)
          agentsGenerated++
        }
      }

      // Mark processed
      if (!dryRun) {
        const pending = yield* observations.getPending()
        yield* observations.markProcessed(pending.map((o) => o.id))
      }

      return { skillsGenerated, agentsGenerated, drafts }
    })

    const stats = Effect.fn("SkillLearning.stats")(function* () {
      const pending = yield* observations.getPending()
      return {
        pendingObservations: pending.length,
        totalRecorded: pending.length, // Simplified — real impl would track total separately
      }
    })

    return Service.of({ observeToolEvent, analyzeAndGenerate, stats })
  }),
).pipe(
  Layer.provide(ObsLayer),
  Layer.provide(GenLayer),
)

export const defaultLayer = layer
