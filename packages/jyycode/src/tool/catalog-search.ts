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

const DEFAULT_LIMIT = 8
const MIN_LIMIT = 1
const MAX_LIMIT = 20

export function clampLimit(limit = DEFAULT_LIMIT) {
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export function tokenize(input: string | undefined) {
  return (input ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(Boolean) ?? []
}

export function search(input: SearchInput): SearchResult[] {
  const terms = tokenize(input.query)
  const category = input.category?.toLowerCase()
  const limit = clampLimit(input.limit)
  if (terms.length === 0 && !category) return []

  return input.tools
    .filter((tool) => tool.id !== "tool_search")
    .filter((tool) => (category ? tool.catalog?.category === category : true))
    .map((tool) => ({ tool, score: score(tool, terms, input.query) }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .slice(0, limit)
}

export function formatResults(results: SearchResult[], options: { detail?: Detail } = {}) {
  const detail = options.detail ?? "summary"
  if (results.length === 0) return "No matching tools found in the currently available tool catalog."

  return results.map((result) => formatResult(result, detail)).join("\n\n")
}

function score(tool: Tool.Def, terms: string[], query: string) {
  const id = tool.id.toLowerCase()
  const idTokens = tokenize(tool.id)
  const descriptionTokens = tokenize(tool.description)
  const categoryTokens = tokenize(tool.catalog?.category)
  const tagTokens = (tool.catalog?.tags ?? []).flatMap(tokenize)
  const parameterTokens = parameterNames(tool).flatMap(tokenize)
  const normalizedQuery = query.trim().toLowerCase()

  let total = normalizedQuery === id ? 100 : 0
  for (const term of terms) {
    if (id === term) total += 100
    if (idTokens.includes(term)) total += 40
    if (tagTokens.includes(term)) total += 25
    if (categoryTokens.includes(term)) total += 20
    if (descriptionTokens.includes(term)) total += bm25ish(descriptionTokens, term) * 10
    if (parameterTokens.includes(term)) total += 5
  }
  return total
}

function bm25ish(tokens: string[], term: string) {
  const frequency = tokens.filter((token) => token === term).length
  if (frequency === 0) return 0
  return frequency / (frequency + 1)
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
  const lines = [
    `- ${tool.id}`,
    catalog ? `  ${catalog}` : undefined,
    `  description: ${tool.description}`,
  ].filter(Boolean) as string[]

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
