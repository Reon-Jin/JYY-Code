import { normalizeKeywords } from "./memory"

export const BM25_K1 = 1.5
export const BM25_B = 0.75
export const FIELD_WEIGHTS = { keywords: 3, content: 1, evidence: 0.5 } as const
export const EXACT_KEYWORD_BOOST = 0.6
export const CONTAIN_KEYWORD_BOOST = 0.4
export const GOAL_TERM_WEIGHT = 0.5
export const KEYWORD_BOOST_CAP = 1

export type FieldName = "keywords" | "content" | "evidence"
export const FIELDS: readonly FieldName[] = ["keywords", "content", "evidence"]

export type ScoredExperience = {
  keywords: readonly string[]
  content: string
  evidence: string
}

export type CorpusStats = {
  docCount: number
  documentFrequency: ReadonlyMap<string, number>
  averageFieldLengths: Record<FieldName, number>
  idf(term: string): number
}

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
  const tokens: string[] = []
  for (const word of normalized.match(/[a-z0-9]+/gu) ?? []) tokens.push(word)
  for (const run of normalized.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    if (run.length === 1) tokens.push(run)
    else for (let index = 0; index < run.length - 1; index++) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function buildCorpusStats(entries: readonly ScoredExperience[]): CorpusStats {
  const docCount = entries.length
  const documentFrequency = new Map<string, number>()
  const fieldLengths: Record<FieldName, number[]> = { keywords: [], content: [], evidence: [] }
  const seen = new Set<string>()
  for (const entry of entries) {
    const fields: Record<FieldName, string[]> = {
      keywords: tokenize(entry.keywords.join(" ")),
      content: tokenize(entry.content),
      evidence: tokenize(entry.evidence),
    }
    for (const field of FIELDS) fieldLengths[field].push(fields[field].length)
    seen.clear()
    for (const field of FIELDS) {
      for (const token of fields[field]) {
        if (!seen.has(token)) {
          seen.add(token)
          documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
        }
      }
    }
  }
  const averageFieldLengths = {
    keywords: average(fieldLengths.keywords),
    content: average(fieldLengths.content),
    evidence: average(fieldLengths.evidence),
  }
  return {
    docCount,
    documentFrequency,
    averageFieldLengths,
    idf(term: string) {
      const df = documentFrequency.get(term) ?? 0
      return Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
    },
  }
}

export function buildQueryTerms(keywords: readonly string[], text: string, textWeight = GOAL_TERM_WEIGHT): Map<string, number> {
  const terms = new Map<string, number>()
  for (const keyword of keywords) {
    for (const token of tokenize(keyword)) {
      terms.set(token, Math.max(terms.get(token) ?? 0, 1))
    }
  }
  for (const token of tokenize(text)) {
    const current = terms.get(token)
    terms.set(token, current === undefined ? textWeight : Math.max(current, textWeight))
  }
  return terms
}

function termFrequency(tokens: readonly string[], term: string): number {
  let count = 0
  for (const token of tokens) if (token === term) count++
  return count
}

function keywordBoost(entryKeywords: readonly string[], queryKeywords: readonly string[]): number {
  if (queryKeywords.length === 0) return 0
  const normalizedEntry = normalizeKeywords(entryKeywords)
  const normalizedQuery = normalizeKeywords(queryKeywords)
  let boost = 0
  for (const queryKeyword of normalizedQuery) {
    for (const entryKeyword of normalizedEntry) {
      if (queryKeyword === entryKeyword) {
        boost += EXACT_KEYWORD_BOOST
        break
      }
      if (queryKeyword.includes(entryKeyword) || entryKeyword.includes(queryKeyword)) {
        boost += CONTAIN_KEYWORD_BOOST
        break
      }
    }
  }
  return Math.min(KEYWORD_BOOST_CAP, boost)
}

export function scoreExperience(
  entry: ScoredExperience,
  queryTerms: ReadonlyMap<string, number>,
  keywordQuery: readonly string[],
  stats: CorpusStats,
): number {
  const fields: Array<{ name: FieldName; tokens: string[]; weight: number }> = [
    { name: "keywords", tokens: tokenize(entry.keywords.join(" ")), weight: FIELD_WEIGHTS.keywords },
    { name: "content", tokens: tokenize(entry.content), weight: FIELD_WEIGHTS.content },
    { name: "evidence", tokens: tokenize(entry.evidence), weight: FIELD_WEIGHTS.evidence },
  ]
  let score = 0
  for (const [term, queryWeight] of queryTerms) {
    const idf = stats.idf(term)
    if (idf <= 0) continue
    for (const field of fields) {
      const tf = termFrequency(field.tokens, term)
      if (tf === 0) continue
      const avg = stats.averageFieldLengths[field.name]
      const normalizedLength = avg > 0 ? field.tokens.length / avg : 1
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLength)
      score += field.weight * queryWeight * idf * ((tf * (BM25_K1 + 1)) / denominator)
    }
  }
  return score + keywordBoost(entry.keywords, keywordQuery)
}
