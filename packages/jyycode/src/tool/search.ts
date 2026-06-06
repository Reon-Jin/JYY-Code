/**
 * TF-IDF tool search engine. Enables on-demand tool discovery via semantic search,
 * reducing the initial tool list size by deferring rarely-used tools.
 *
 * Ported from claudecode's src/services/searchExtraTools/toolIndex.ts and prefetch.ts.
 */
import { Effect, Layer, Context } from "effect"
import {
  tokenizeAndStem,
  computeWeightedTf,
  computeIdf,
  cosineSimilarity,
  STOP_WORDS,
  stem,
} from "@/util/tfidf"
import type { Tool } from "./tool"
import { type SearchResult as SkillSearchResult } from "@/skill/search"

const isCjk = (ch: string): boolean => /[一-鿿㐀-䶿]/.test(ch)

const FIELD_WEIGHT = {
  name: 3.0,
  searchHint: 2.5,
  description: 1.0,
}

const DISPLAY_MIN_SCORE = 0.1
const NAME_MATCH_MIN_LENGTH = 4
const CJK_MIN_BIGRAM_MATCHES = 2

/** Parse a tool name into searchable parts. Handles mcp__server__tool and CamelCase. */
export function parseToolName(name: string): string[] {
  const parts: string[] = []

  // Handle mcp__server__tool format
  if (name.includes("__")) {
    const segments = name.split("__")
    for (const seg of segments) {
      parts.push(seg.toLowerCase())
    }
  }

  // Handle CamelCase
  const camelParts = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_-]+/)
  for (const part of camelParts) {
    const lower = part.toLowerCase()
    if (lower && !STOP_WORDS.has(lower)) {
      parts.push(lower)
    }
  }

  return [...new Set(parts)]
}

export interface ToolIndexEntry {
  name: string
  description: string
  searchHint: string | undefined
  tokens: string[]
  tfVector: Map<string, number>
}

export interface ToolSearchResult {
  name: string
  description: string
  score: number
  searchHint?: string
}

export interface Interface {
  /** Build a tool search index from a list of tool definitions. */
  readonly buildIndex: (tools: Tool.Info<any, any>[]) => Effect.Effect<ToolIndexEntry[]>
  /** Search tools by natural language query. */
  readonly search: (query: string, index: ToolIndexEntry[], limit?: number) => Effect.Effect<ToolSearchResult[]>
  /** Extract search query from recent messages. */
  readonly extractQuery: (messages: string[]) => Effect.Effect<string | null>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/ToolSearch") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const buildIndex = Effect.fn("ToolSearch.buildIndex")(function* (tools: Tool.Info<any, any>[]) {
      const entries: ToolIndexEntry[] = []
      for (const tool of tools) {
        const name = tool.id
        const searchHint = (tool as any).searchHint as string | undefined
        const description = (tool as any).description as string | undefined ?? ""

        const nameTokens = tokenizeAndStem(name)
        const parsedParts = parseToolName(name)
          .flatMap((p) => tokenizeAndStem(p))
        const nameWithParts = [...new Set([...nameTokens, ...parsedParts])]

        const descTokens = tokenizeAndStem(description)
        const hintTokens = tokenizeAndStem(searchHint ?? "")

        const allTokens = [
          ...new Set([
            ...nameWithParts,
            ...descTokens,
            ...hintTokens,
          ]),
        ]

        const tfVector = computeWeightedTf([
          { tokens: nameWithParts, weight: FIELD_WEIGHT.name },
          { tokens: hintTokens, weight: FIELD_WEIGHT.searchHint },
          { tokens: descTokens, weight: FIELD_WEIGHT.description },
        ])

        entries.push({
          name,
          description,
          searchHint,
          tokens: allTokens,
          tfVector,
        })
      }

      const idf = computeIdf(entries)
      for (const entry of entries) {
        for (const [term, tf] of entry.tfVector) {
          entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
        }
      }

      return entries
    })

    const search = Effect.fn("ToolSearch.search")(function* (
      query: string,
      index: ToolIndexEntry[],
      limit = 5,
    ) {
      if (index.length === 0 || !query?.trim()) return []

      const queryTokens = tokenizeAndStem(query)
      if (queryTokens.length === 0) return []

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
      const queryLower = query.toLowerCase()

      const results: ToolSearchResult[] = []
      for (const entry of index) {
        let score = cosineSimilarity(queryTfIdf, entry.tfVector)

        if (queryCjkTokens.length > 0 && score > 0) {
          const matchingCjk = queryCjkTokens.filter((t) => entry.tfVector.has(t))
          if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {
            const hasAsciiMatch = queryAsciiTokens.some((t) => entry.tfVector.has(t))
            if (!hasAsciiMatch) score = 0
          }
        }

        if (entry.name.length >= NAME_MATCH_MIN_LENGTH) {
          if (queryLower.includes(entry.name.toLowerCase())) {
            score = Math.max(score, 0.75)
          }
        }

        if (score >= DISPLAY_MIN_SCORE) {
          results.push({
            name: entry.name,
            description: entry.description,
            score,
            searchHint: entry.searchHint,
          })
        }
      }

      results.sort((a, b) => b.score - a.score)
      return results.slice(0, limit)
    })

    const extractQuery = Effect.fn("ToolSearch.extractQuery")(function* (messages: string[]) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg && msg.trim().length > 0) {
          return msg.trim().slice(0, 500)
        }
      }
      return null
    })

    return Service.of({ buildIndex, search, extractQuery })
  }),
)

export const defaultLayer = layer
