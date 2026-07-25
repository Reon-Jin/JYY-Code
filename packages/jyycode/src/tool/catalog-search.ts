import type { JSONSchema7 } from "@ai-sdk/provider"
import { ToolJsonSchema } from "./json-schema"
import type { Tool } from "./tool"

export type Detail = "summary" | "schema" | "full"

export type SearchInput = {
  tools: Tool.Def[]
  query: string
  limit?: number
  detail?: Detail
  category?: string
}

export type SearchResult = {
  tool: Tool.Def
  score: number
}

type FieldName = "id" | "tags" | "category" | "parameters" | "description" | "examples"

type FieldStats = {
  averageLength: number
  documentFrequency: Map<string, number>
}

type SearchStats = Record<FieldName, FieldStats>

const DEFAULT_LIMIT = 8
const MIN_LIMIT = 1
const MAX_LIMIT = 20
const BM25_K1 = 1.2
const BM25_B = 0.75

const FIELD_WEIGHTS: Record<FieldName, number> = {
  id: 4,
  tags: 3,
  category: 1.5,
  parameters: 1.2,
  description: 1,
  examples: 1.5,
}

export function clampLimit(limit = DEFAULT_LIMIT) {
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export function tokenize(input: string | undefined) {
  return (
    (input ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter(Boolean) ?? []
  )
}

export function search(input: SearchInput): SearchResult[] {
  const terms = tokenize(input.query)
  const category = input.category?.toLowerCase()
  const limit = clampLimit(input.limit)
  if (terms.length === 0 && !category) return []

  const candidates = input.tools
    .filter((tool) => tool.id !== "tool_search")
    .filter((tool) => (category ? tool.catalog?.category === category : true))
  const stats = buildStats(candidates)

  return candidates
    .map((tool) => ({
      tool,
      score: score(tool, terms, input.query, stats, candidates.length) + (category && terms.length === 0 ? 20 : 0),
    }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .slice(0, limit)
}

export function formatResults(results: SearchResult[], options: { detail?: Detail } = {}) {
  const detail = options.detail ?? "summary"
  if (results.length === 0) return "No matching tools found in the currently available tool catalog."

  return results.map((result) => formatResult(result, detail)).join("\n\n")
}

function score(tool: Tool.Def, terms: string[], query: string, stats: SearchStats, documentCount: number) {
  const id = tool.id.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  const fields = toolFields(tool)

  let total = normalizedQuery === id ? 100 : 0
  for (const term of terms) {
    if (id === term) total += 100
    for (const [field, tokens] of Object.entries(fields) as [FieldName, string[]][]) {
      total += FIELD_WEIGHTS[field] * bm25(tokens, term, stats[field], documentCount)
    }
  }
  total += intentBonus(tool, terms)
  return total
}

function intentBonus(tool: Tool.Def, terms: string[]) {
  const writeTerms = ["change", "edit", "modify", "patch", "write"]
  const communicationTerms = ["send", "message", "email", "share"]
  if (tool.catalog?.mutability === "write" && terms.some((term) => writeTerms.includes(term))) {
    return 30
  }
  if (tool.catalog?.category === "communication" && terms.some((term) => communicationTerms.includes(term))) {
    return 30
  }
  return 0
}

function buildStats(tools: Tool.Def[]): SearchStats {
  const fields = Object.keys(FIELD_WEIGHTS) as FieldName[]
  const result = Object.fromEntries(
    fields.map((field) => [field, { averageLength: 0, documentFrequency: new Map<string, number>() }]),
  ) as SearchStats

  for (const field of fields) {
    const documents = tools.map((tool) => toolFields(tool)[field])
    result[field].averageLength =
      documents.length === 0 ? 0 : documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length
    for (const tokens of documents) {
      for (const token of new Set(tokens)) {
        result[field].documentFrequency.set(token, (result[field].documentFrequency.get(token) ?? 0) + 1)
      }
    }
  }

  return result
}

function toolFields(tool: Tool.Def): Record<FieldName, string[]> {
  return {
    id: tokenize(tool.id),
    tags: (tool.catalog?.tags ?? []).flatMap(tokenize),
    category: tokenize(tool.catalog?.category),
    parameters: parameterNames(tool).flatMap(tokenize),
    description: tokenize(tool.description),
    examples: (tool.catalog?.examples ?? []).flatMap(tokenize),
  }
}

function bm25(tokens: string[], term: string, stats: FieldStats, documentCount: number) {
  const frequency = tokens.filter((token) => token === term).length
  if (frequency === 0) return 0
  const documentFrequency = stats.documentFrequency.get(term) ?? 0
  const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
  const averageLength = stats.averageLength || 1
  const length = tokens.length
  const normalizedFrequency =
    (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (length / averageLength)))
  return idf * normalizedFrequency
}

function formatResult(result: SearchResult, detail: Detail) {
  const tool = result.tool
  const schema = schemaFor(tool)
  const properties = propertyNames(schema)
  const catalog = [
    tool.catalog?.category ? `category: ${tool.catalog.category}` : undefined,
    tool.catalog?.mutability ? `mutability: ${tool.catalog.mutability}` : undefined,
    tool.catalog?.risk ? `risk: ${tool.catalog.risk}` : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  const lines = [`- ${tool.id}`, catalog ? `  ${catalog}` : undefined, `  description: ${tool.description}`].filter(
    Boolean,
  ) as string[]

  if (detail === "summary") return lines.join("\n")

  lines.push(`  parameters: ${properties.length ? properties.join(", ") : "(schema unavailable)"}`)
  if (detail === "schema") return lines.join("\n")

  lines.push(`  score: ${Number(result.score.toFixed(2))}`)
  if (tool.catalog?.tags?.length) lines.push(`  tags: ${tool.catalog.tags.join(", ")}`)
  if (tool.catalog?.examples?.length) lines.push(`  examples: ${tool.catalog.examples.join(" | ")}`)
  if (schema) lines.push(`  schema: ${JSON.stringify(schema)}`)
  return lines.join("\n")
}

function parameterNames(tool: Tool.Def) {
  return propertyNames(schemaFor(tool))
}

function schemaFor(tool: Tool.Def): JSONSchema7 | undefined {
  try {
    const schema = ToolJsonSchema.fromTool(tool)
    return typeof schema === "boolean" ? undefined : schema
  } catch {
    return undefined
  }
}

function propertyNames(schema: JSONSchema7 | undefined) {
  return schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : []
}

export * as CatalogSearch from "./catalog-search"
