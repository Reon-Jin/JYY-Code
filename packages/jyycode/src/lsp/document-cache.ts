export const DEFAULT_MAX_OPEN_DOCUMENTS = 50
export const HARD_MAX_OPEN_DOCUMENTS = 200
export const DEFAULT_MAX_DOCUMENT_TEXT_BYTES = 1024 * 1024
export const HARD_MAX_DOCUMENT_TEXT_BYTES = 4 * 1024 * 1024
export const MAX_DIAGNOSTICS_PER_FILE = 200

export interface DocumentEntry {
  readonly version: number
  readonly text: string
  readonly textBytes: number
  readonly textTruncated: boolean
}

export interface DocumentCacheOptions {
  readonly maxOpenDocuments?: number
  readonly maxDocumentTextBytes?: number
}

function clamp(value: number | undefined, fallback: number, hardMax: number) {
  return Math.max(1, Math.min(hardMax, Math.floor(value ?? fallback)))
}

function boundedText(text: string, maxBytes: number) {
  const textBytes = Buffer.byteLength(text)
  if (textBytes <= maxBytes) return { text, textBytes, textTruncated: false }
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end--
  return { text: text.slice(0, end), textBytes: textBytes, textTruncated: true }
}

/** A bounded LRU for open-document protocol state, never an unbounded object map. */
export class DocumentCache {
  readonly maxOpenDocuments: number
  readonly maxDocumentTextBytes: number
  private readonly entries = new Map<string, DocumentEntry>()

  constructor(options: DocumentCacheOptions = {}) {
    this.maxOpenDocuments = clamp(options.maxOpenDocuments, DEFAULT_MAX_OPEN_DOCUMENTS, HARD_MAX_OPEN_DOCUMENTS)
    this.maxDocumentTextBytes = clamp(
      options.maxDocumentTextBytes,
      DEFAULT_MAX_DOCUMENT_TEXT_BYTES,
      HARD_MAX_DOCUMENT_TEXT_BYTES,
    )
  }

  set(key: string, version: number, text: string) {
    const entry = { version, ...boundedText(text, this.maxDocumentTextBytes) }
    this.entries.delete(key)
    this.entries.set(key, entry)
    const evicted: Array<{ key: string; entry: DocumentEntry }> = []
    while (this.entries.size > this.maxOpenDocuments) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const oldestEntry = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (oldestEntry) evicted.push({ key: oldest, entry: oldestEntry })
    }
    return evicted
  }

  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  close(key: string) {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    return entry
  }

  has(key: string) {
    return this.entries.has(key)
  }

  keys() {
    return [...this.entries.keys()]
  }

  get size() {
    return this.entries.size
  }
}

export function limitDiagnostics<T>(items: readonly T[], max = MAX_DIAGNOSTICS_PER_FILE) {
  return items.length <= max ? [...items] : items.slice(0, max)
}

export * as DocumentCacheNS from "./document-cache"
