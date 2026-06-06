/**
 * Skill learning type definitions.
 * Models observations, instincts (learned patterns), and generated skill drafts.
 *
 * Ported from claudecode's src/services/skillLearning/types.ts.
 */

export type SkillLearningScope = "project" | "global"

export type InstinctDomain =
  | "workflow"
  | "testing"
  | "debugging"
  | "code-style"
  | "security"
  | "git"
  | "project"

export type InstinctStatus =
  | "observed"
  | "candidate"
  | "promoted"
  | "merged"
  | "superseded"
  | "rejected"
  | "stale"
  | "error"

export type InstinctSource = "tool_event" | "session_pattern" | "llm_analysis"

/** A single behavioral observation from a tool event or session pattern. */
export interface SkillObservation {
  id: string
  timestamp: number
  source: InstinctSource
  domain: InstinctDomain
  toolName?: string
  toolInput?: Record<string, unknown>
  sessionId?: string
  pattern: string
  context: string
  confidence: number // 0-1
}

/** An extracted pattern (instinct) from one or more observations. */
export interface Instinct {
  id: string
  domain: InstinctDomain
  pattern: string
  description: string
  confidence: number
  evidence: SkillObservation[]
  status: InstinctStatus
  createdAt: number
  updatedAt: number
}

/** A candidate instinct produced by LLM analysis. */
export interface InstinctCandidate {
  domain: InstinctDomain
  pattern: string
  description: string
  trigger: string
  action: string
  confidence: number
}

/** A generated skill draft ready to be written to disk. */
export interface LearnedSkillDraft {
  name: string
  description: string
  scope: SkillLearningScope
  domain: InstinctDomain
  confidence: number
  trigger: string
  action: string
  evidence: string[]
  evolvedFrom?: string[]
}

export interface LearnedAgentDraft {
  name: string
  description: string
  scope: SkillLearningScope
  triggers: string[]
  playbook: string[]
  evidence: string[]
}

export const MIN_CONFIDENCE_TO_GENERATE = 0.75
export const DUPLICATE_SKILL_OVERLAP_THRESHOLD = 0.8
export const MAX_OBSERVATIONS_PER_ANALYSIS = 30
export const MAX_CANDIDATES_PER_ANALYSIS = 3
export const MAX_SKILL_FILE_BYTES = 50_000
export const MAX_EVIDENCE_LINES_PER_APPEND = 20
