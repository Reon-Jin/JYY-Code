import type { Importance } from "./memory"

export const EXPERIENCE_KINDS = ["success", "failure", "lesson"] as const
export type ExperienceKind = (typeof EXPERIENCE_KINDS)[number]

export const EXPERIENCE_STATUSES = ["active", "superseded", "retracted"] as const
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number]

export const EXPERIENCE_CONFIDENCES = ["low", "medium", "high"] as const
export type ExperienceConfidence = (typeof EXPERIENCE_CONFIDENCES)[number]

export const EXPERIENCE_CONTENT_CHAR_LIMIT = 200
export const EXPERIENCE_EVIDENCE_CHAR_LIMIT = 160
export const EXPERIENCE_EVIDENCE_ANCHOR = /^\[[^\[\]\s]+\s*#\d+\]/u

export type ExperienceCandidate = {
  kind: ExperienceKind
  importance: Importance
  keywords: string[]
  content: string
  evidence: string
  confidence: ExperienceConfidence
}
