import { MemoryDb, type SearchOptions } from "./memory-db"

export interface ContextPackConfig {
  maxObservations?: number
  maxSummaries?: number
  observationTypes?: string[]
  concepts?: string[]
}

export interface ContextPack {
  observations: string
  summaries: string
  combined: string
  metadata: {
    observationCount: number
    summaryCount: number
    totalTokens: number
  }
}

const CHARS_PER_TOKEN = 4

function formatObservation(obs: {
  type: string
  title: string | null
  narrative: string | null
  facts: string
  concepts: string
}): string {
  const parts: string[] = []
  parts.push(`[${obs.type}] ${obs.title || "(untitled)"}`)
  if (obs.narrative) {
    parts.push(`  ${obs.narrative.slice(0, 500)}`)
  }
  try {
    const facts: string[] = JSON.parse(obs.facts || "[]")
    if (facts.length > 0) {
      parts.push(`  Facts: ${facts.map((f) => `- ${f}`).join("; ")}`.slice(0, 400))
    }
  } catch {
    // ignore parse errors
  }
  return parts.join("\n")
}

function formatSummary(summary: {
  request: string | null
  completed: string | null
  learned: string | null
  next_steps: string | null
}): string {
  const parts: string[] = []
  if (summary.request) parts.push(`Request: ${summary.request.slice(0, 200)}`)
  if (summary.completed) parts.push(`Completed: ${summary.completed.slice(0, 300)}`)
  if (summary.learned) parts.push(`Learned: ${summary.learned.slice(0, 200)}`)
  if (summary.next_steps) parts.push(`Next: ${summary.next_steps.slice(0, 200)}`)
  return parts.join(" | ")
}

export function buildContextPack(
  db: MemoryDb,
  config: ContextPackConfig = {},
): ContextPack {
  const maxObs = config.maxObservations ?? 10
  const maxSummaries = config.maxSummaries ?? 3

  const searchOpts: SearchOptions = {
    limit: maxObs,
    types: config.observationTypes,
    concepts: config.concepts,
  }
  const observations = db.searchObservations(searchOpts)
  const summaries = db.getRecentSummaries(maxSummaries)

  const obsText = observations.length === 0
    ? ""
    : "## Persistent Memory (Observations)\n\n" +
      observations.map(formatObservation).join("\n\n")

  const sumText = summaries.length === 0
    ? ""
    : "## Recent Session Summaries\n\n" +
      summaries.map(formatSummary).join("\n")

  const combined = [obsText, sumText].filter(Boolean).join("\n\n---\n\n")
  const totalChars = combined.length

  return {
    observations: obsText,
    summaries: sumText,
    combined,
    metadata: {
      observationCount: observations.length,
      summaryCount: summaries.length,
      totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    },
  }
}
