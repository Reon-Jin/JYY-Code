/**
 * TF-IDF skill search engine. Indexes skills by name, description, whenToUse,
 * and allowedTools fields, then ranks matches using cosine similarity.
 *
 * Ported from claudecode's src/services/skillSearch/localSearch.ts and prefetch.ts.
 */
import { Effect, Layer, Context } from "effect"
import {
  tokenizeAndStem,
  computeWeightedTf,
  computeIdf,
  cosineSimilarity,
  normalizeName,
  splitHyphenatedName,
  STOP_WORDS,
  stem,
} from "@/util/tfidf"
import type { Info as SkillInfo } from "./index"

const isCjk = (ch: string): boolean => /[一-鿿㐀-䶿]/.test(ch)

const FIELD_WEIGHT = {
  name: 3.0,
  whenToUse: 2.0,
  description: 1.0,
  allowedTools: 0.3,
} as const

const DISPLAY_MIN_SCORE = 0.1
const NAME_MATCH_MIN_LENGTH = 4
const CJK_MIN_BIGRAM_MATCHES = 2

export interface SkillIndexEntry {
  name: string
  normalizedName: string
  description: string
  whenToUse: string | undefined
  source: string
  location: string | undefined
  contentLength: number | undefined
  tokens: string[]
  tfVector: Map<string, number>
}

export interface SearchResult {
  name: string
  description: string
  score: number
  source?: string
  location?: string
  contentLength?: number
}

export interface Interface {
  /** Build or rebuild the skill index. */
  readonly buildIndex: (skills: SkillInfo[]) => Effect.Effect<SkillIndexEntry[]>
  /** Search indexed skills with a natural language query. */
  readonly search: (query: string, index: SkillIndexEntry[], limit?: number) => Effect.Effect<SearchResult[]>
  /** Extract a search query from recent conversation messages. */
  readonly extractQuery: (messages: string[]) => Effect.Effect<string | null>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SkillSearch") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const buildIndex = Effect.fn("SkillSearch.buildIndex")(function* (skills: SkillInfo[]) {
      const entries: SkillIndexEntry[] = []
      for (const skill of skills) {
        const name = skill.name
        const description = skill.description ?? ""
        const whenToUse = undefined // SkillInfo doesn't have whenToUse, use description
        const allowedTools = "" // SkillInfo doesn't have allowedTools

        const nameTokens = tokenizeAndStem(name)
        const nameParts = splitHyphenatedName(name)
        const nameWithParts = [
          ...nameTokens,
          ...nameParts.map(stem).filter((t) => !STOP_WORDS.has(t)),
        ]

        const descTokens = tokenizeAndStem(description)
        const whenTokens = tokenizeAndStem(whenToUse ?? "")
        const toolsTokens = tokenizeAndStem(allowedTools)

        const allTokens = [
          ...new Set([
            ...nameWithParts,
            ...descTokens,
            ...whenTokens,
            ...toolsTokens,
          ]),
        ]

        const tfVector = computeWeightedTf([
          { tokens: nameWithParts, weight: FIELD_WEIGHT.name },
          { tokens: whenTokens, weight: FIELD_WEIGHT.whenToUse },
          { tokens: descTokens, weight: FIELD_WEIGHT.description },
          { tokens: toolsTokens, weight: FIELD_WEIGHT.allowedTools },
        ])

        entries.push({
          name,
          normalizedName: normalizeName(name),
          description,
          whenToUse,
          source: "skill",
          location: skill.location,
          contentLength: skill.content?.length,
          tokens: allTokens,
          tfVector,
        })
      }

      // Apply IDF weighting
      const idf = computeIdf(entries)
      for (const entry of entries) {
        for (const [term, tf] of entry.tfVector) {
          entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
        }
      }

      return entries
    })

    const search = Effect.fn("SkillSearch.search")(function* (
      query: string,
      index: SkillIndexEntry[],
      limit = 5,
    ) {
      if (index.length === 0 || !query?.trim()) return []

      const queryTokens = tokenizeAndStem(query)
      if (queryTokens.length === 0) return []

      // Build query TF-IDF vector
      const queryTf = new Map<string, number>()
      const freq = new Map<string, number>()
      for (const t of queryTokens) freq.set(t, (freq.get(t) ?? 0) + 1)
      let max = 1
      for (const v of freq.values()) if (v > max) max = v
      for (const [term, count] of freq) queryTf.set(term, count / max)

      const idf = computeIdf(index)
      const queryTfIdf = new Map<string, number>()
      for (const [term, tf] of queryTf) {
        queryTfIdf.set(term, tf * (idf.get(term) ?? 0))
      }

      const queryCjkTokens = queryTokens.filter((t) => isCjk(t[0] ?? ""))
      const queryAsciiTokens = queryTokens.filter((t) => !isCjk(t[0] ?? ""))
      const queryLower = query.toLowerCase().replace(/[-_]/g, " ")

      const results: SearchResult[] = []
      for (const entry of index) {
        let score = cosineSimilarity(queryTfIdf, entry.tfVector)

        // CJK validation: require at least 2 matching bigrams or ASCII match
        if (queryCjkTokens.length > 0 && score > 0) {
          const matchingCjk = queryCjkTokens.filter((t) => entry.tfVector.has(t))
          if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {
            const hasAsciiMatch = queryAsciiTokens.some((t) => entry.tfVector.has(t))
            if (!hasAsciiMatch) score = 0
          }
        }

        // Name substring boost
        if (entry.name.length >= NAME_MATCH_MIN_LENGTH) {
          if (queryLower.includes(entry.normalizedName)) {
            score = Math.max(score, 0.75)
          }
        }

        if (score >= DISPLAY_MIN_SCORE) {
          results.push({
            name: entry.name,
            description: entry.description,
            score,
            source: entry.source,
            location: entry.location,
            contentLength: entry.contentLength,
          })
        }
      }

      results.sort((a, b) => b.score - a.score)
      return results.slice(0, limit)
    })

    const extractQuery = Effect.fn("SkillSearch.extractQuery")(function* (messages: string[]) {
      // Walk backward through messages to find user text
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg && msg.trim().length > 0) {
          // Take the last user message, capped at 500 chars
          return msg.trim().slice(0, 500)
        }
      }
      return null
    })

    return Service.of({ buildIndex, search, extractQuery })
  }),
)

export const defaultLayer = layer
