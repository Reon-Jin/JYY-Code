/**
 * Shared TF-IDF search engine for skill and tool discovery.
 * Supports CJK bigram tokenization, English stemming, weighted TF,
 * IDF computation, and cosine similarity ranking.
 *
 * Ported from claudecode's src/services/skillSearch/localSearch.ts.
 */

export const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "this", "that",
  "these", "those", "it", "its", "i", "me", "my", "we", "our", "you",
  "your", "he", "him", "his", "she", "her", "they", "them", "their",
  "what", "which", "who", "whom", "use", "using",
])

const CJK_RANGE = /[一-鿿㐀-䶿]/

function isCjk(ch: string): boolean {
  return CJK_RANGE.test(ch)
}

/** Tokenize text: CJK bigrams + alphanumeric tokens, with stop word removal. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let i = 0

  while (i < lower.length) {
    if (isCjk(lower[i]!)) {
      let cjkRun = ""
      while (i < lower.length && isCjk(lower[i]!)) {
        cjkRun += lower[i]
        i++
      }
      for (let j = 0; j < cjkRun.length - 1; j++) {
        tokens.push(cjkRun.slice(j, j + 2))
      }
    } else if (/[a-z0-9]/.test(lower[i]!)) {
      let word = ""
      while (i < lower.length && /[a-z0-9\-_]/.test(lower[i]!)) {
        word += lower[i]
        i++
      }
      const cleaned = word.replace(/^[-_]+|[-_]+$/g, "")
      if (cleaned && !STOP_WORDS.has(cleaned)) {
        tokens.push(cleaned)
      }
    } else {
      i++
    }
  }

  return tokens
}

/** Basic English stemmer: removes common suffixes. */
export function stem(word: string): string {
  if (isCjk(word[0] ?? "")) return word
  let s = word
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3)
  else if (s.endsWith("tion") && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith("ness") && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith("ment") && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith("ers") && s.length > 4) s = s.slice(0, -1)
  else if (s.endsWith("er") && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith("es") && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith("s") && s.length > 3 && !s.endsWith("ss")) s = s.slice(0, -1)
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith("ly") && s.length > 4) s = s.slice(0, -2)
  return s
}

/** Tokenize text and apply stemming. */
export function tokenizeAndStem(text: string): string[] {
  return tokenize(text).map(stem)
}

/** Field weights for weighted TF computation. */
export const DEFAULT_FIELD_WEIGHTS = {
  name: 3.0,
  whenToUse: 2.0,
  description: 1.0,
  allowedTools: 0.3,
} as const

/**
 * Compute weighted term frequency with per-field max normalization.
 * Takes an array of {tokens, weight} fields and returns a Map<term, weighted_tf>.
 */
export function computeWeightedTf(
  fields: { tokens: string[]; weight: number }[],
): Map<string, number> {
  const weighted = new Map<string, number>()
  for (const field of fields) {
    const freq = new Map<string, number>()
    for (const t of field.tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
    let max = 1
    for (const v of freq.values()) if (v > max) max = v
    for (const [term, count] of freq) {
      const val = (count / max) * field.weight
      const existing = weighted.get(term) ?? 0
      if (val > existing) weighted.set(term, val)
    }
  }
  return weighted
}

/** Compute inverse document frequency across an index. */
export function computeIdf(index: { tokens: string[] }[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const entry of index) {
    const seen = new Set<string>()
    for (const t of entry.tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1)
        seen.add(t)
      }
    }
  }
  const N = index.length
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log(N / count))
  }
  return idf
}

/** Compute cosine similarity between query and document TF-IDF vectors. */
export function cosineSimilarity(
  queryTfIdf: Map<string, number>,
  docTfIdf: Map<string, number>,
): number {
  let dot = 0
  let normQ = 0
  let normD = 0

  for (const [term, qWeight] of queryTfIdf) {
    const dWeight = docTfIdf.get(term) ?? 0
    dot += qWeight * dWeight
    normQ += qWeight * qWeight
  }
  for (const dWeight of docTfIdf.values()) {
    normD += dWeight * dWeight
  }

  const denom = Math.sqrt(normQ) * Math.sqrt(normD)
  return denom === 0 ? 0 : dot / denom
}

/** Normalize a skill/tool name for comparison. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, " ")
}

/** Split a hyphenated name into constituent parts for better matching. */
export function splitHyphenatedName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .filter((p) => p.length >= 3)
}
