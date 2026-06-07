import { Database } from "bun:sqlite"
import path from "path"
import { createHash } from "crypto"
import * as Log from "@jyycode-ai/core/util/log"
import { DIRECTORY } from "./memory"

const log = Log.create({ service: "memory-db" })

export function getMemoryDbPath(): string {
  return path.join(DIRECTORY, "memory.db")
}

export interface ObservationRow {
  id: number
  memory_session_id: string
  kind: string
  type: string
  title: string | null
  subtitle: string | null
  text: string | null
  narrative: string | null
  facts: string
  concepts: string
  files_read: string
  files_modified: string
  content_hash: string
  discovery_tokens: number
  generated_by_model: string | null
  metadata: string
  time_created: number
  time_updated: number
}

export interface ObservationInput {
  memory_session_id: string
  kind?: string
  type: string
  title?: string | null
  subtitle?: string | null
  text?: string | null
  narrative?: string | null
  facts?: string[]
  concepts?: string[]
  files_read?: string[]
  files_modified?: string[]
  discovery_tokens?: number
  generated_by_model?: string | null
  metadata?: Record<string, unknown>
  time_created?: number
}

export interface SummaryRow {
  id: number
  memory_session_id: string
  project: string
  request: string | null
  investigated: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  notes: string | null
  discovery_tokens: number
  time_created: number
}

export interface SummaryInput {
  memory_session_id: string
  project: string
  request?: string | null
  investigated?: string | null
  learned?: string | null
  completed?: string | null
  next_steps?: string | null
  notes?: string | null
  discovery_tokens?: number
}

export interface SearchResult {
  id: number
  type: string
  title: string | null
  narrative: string | null
  facts: string
  concepts: string
  score: number
  time_created: number
}

export interface SearchOptions {
  query?: string
  types?: string[]
  concepts?: string[]
  limit?: number
}

export function computeContentHash(
  memorySessionId: string,
  title: string | null | undefined,
  narrative: string | null | undefined,
): string {
  return createHash("sha256")
    .update([memorySessionId || "", title || "", (narrative || "").slice(0, 200)].join("\x00"))
    .digest("hex")
    .slice(0, 16)
}

function jsonArray(val: unknown): string {
  return JSON.stringify(val ?? [])
}

export class MemoryDb {
  private db: Database
  private _ftsAvailable: boolean = false

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? getMemoryDbPath()
    this.db = new Database(resolvedPath, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.run("PRAGMA busy_timeout = 5000")
    this.initSchema()
    this.initFTS5()
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'observation',
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        text TEXT,
        narrative TEXT,
        facts TEXT NOT NULL DEFAULT '[]',
        concepts TEXT NOT NULL DEFAULT '[]',
        files_read TEXT NOT NULL DEFAULT '[]',
        files_modified TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        discovery_tokens INTEGER DEFAULT 0,
        generated_by_model TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        notes TEXT,
        discovery_tokens INTEGER DEFAULT 0,
        time_created INTEGER NOT NULL
      )
    `)

    this.db.run("CREATE INDEX IF NOT EXISTS obs_session_idx ON observation(memory_session_id)")
    this.db.run("CREATE INDEX IF NOT EXISTS obs_type_idx ON observation(type)")
    this.db.run("CREATE INDEX IF NOT EXISTS obs_created_idx ON observation(time_created)")
    this.db.run("CREATE INDEX IF NOT EXISTS obs_hash_lookup_idx ON observation(content_hash, time_created)")
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS obs_dedup_idx ON observation(memory_session_id, content_hash)")
    this.db.run("CREATE INDEX IF NOT EXISTS summary_session_idx ON session_summary(memory_session_id)")
    this.db.run("CREATE INDEX IF NOT EXISTS summary_created_idx ON session_summary(time_created)")
  }

  private initFTS5(): void {
    try {
      const hasFTS = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_fts'")
        .get() as { name: string } | undefined
      if (hasFTS) {
        this._ftsAvailable = true
        return
      }
      this.db.run(`
        CREATE VIRTUAL TABLE observation_fts USING fts5(
          memory_item_id UNINDEXED,
          title, subtitle, text, narrative, facts, concepts,
          tokenize='unicode61'
        )
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observation BEGIN
          INSERT INTO observation_fts(memory_item_id, title, subtitle, text, narrative, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.text, new.narrative, new.facts, new.concepts);
        END
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observation BEGIN
          DELETE FROM observation_fts WHERE memory_item_id = old.id;
        END
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observation BEGIN
          DELETE FROM observation_fts WHERE memory_item_id = old.id;
          INSERT INTO observation_fts(memory_item_id, title, subtitle, text, narrative, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.text, new.narrative, new.facts, new.concepts);
        END
      `)
      this._ftsAvailable = true
    } catch (err) {
      log.warn("FTS5 not available, falling back to LIKE search", { error: String(err) })
      this._ftsAvailable = false
    }
  }

  get ftsAvailable(): boolean {
    return this._ftsAvailable
  }

  createObservation(input: ObservationInput): { id: number; timeCreated: number } | null {
    const now = Date.now()
    const hash = computeContentHash(input.memory_session_id, input.title, input.narrative)

    const stmt = this.db.prepare(`
      INSERT INTO observation
        (memory_session_id, kind, type, title, subtitle, text, narrative,
         facts, concepts, files_read, files_modified, content_hash,
         discovery_tokens, generated_by_model, metadata, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, time_created
    `)

    const row = stmt.get(
      input.memory_session_id,
      input.kind ?? "observation",
      input.type,
      input.title ?? null,
      input.subtitle ?? null,
      input.text ?? null,
      input.narrative ?? null,
      jsonArray(input.facts),
      jsonArray(input.concepts),
      jsonArray(input.files_read),
      jsonArray(input.files_modified),
      hash,
      input.discovery_tokens ?? 0,
      input.generated_by_model ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.time_created ?? now,
      now,
    ) as { id: number; time_created: number } | undefined

    if (row) return { id: row.id, timeCreated: row.time_created }

    const existing = this.db
      .prepare("SELECT id, time_created FROM observation WHERE memory_session_id = ? AND content_hash = ?")
      .get(input.memory_session_id, hash) as { id: number; time_created: number } | undefined

    if (existing) {
      log.debug("deduplicated observation", { id: existing.id, hash })
      return { id: existing.id, timeCreated: existing.time_created }
    }
    return null
  }

  getObservation(id: number): ObservationRow | undefined {
    return this.db
      .prepare("SELECT * FROM observation WHERE id = ?")
      .get(id) as ObservationRow | undefined
  }

  searchObservations(opts: SearchOptions = {}): SearchResult[] {
    const limit = opts.limit ?? 10
    const query = opts.query?.trim()

    if (query && this._ftsAvailable) {
      return this.ftsSearch(query, opts, limit)
    }
    return this.likeSearch(query, opts, limit)
  }

  private ftsSearch(query: string, opts: SearchOptions, limit: number): SearchResult[] {
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" ")

    let sql = `
      SELECT o.id, o.type, o.title, o.narrative, o.facts, o.concepts,
             rank AS score, o.time_created
      FROM observation o
      JOIN observation_fts fts ON fts.memory_item_id = o.id
      WHERE observation_fts MATCH ?
    `

    const params: (string | number)[] = [ftsQuery]

    if (opts.types && opts.types.length > 0) {
      sql += ` AND o.type IN (${opts.types.map(() => "?").join(",")})`
      params.push(...opts.types)
    }
    if (opts.concepts && opts.concepts.length > 0) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value IN (${opts.concepts.map(() => "?").join(",")}))`
      params.push(...opts.concepts)
    }

    sql += " ORDER BY rank LIMIT ?"
    params.push(limit)

    return this.db.prepare(sql).all(...params) as SearchResult[]
  }

  private likeSearch(query: string | undefined, opts: SearchOptions, limit: number): SearchResult[] {
    let sql = "SELECT id, type, title, narrative, facts, concepts, time_created FROM observation WHERE 1=1"
    const params: (string | number)[] = []

    if (query) {
      const likeTerm = `%${query}%`
      sql += " AND (title LIKE ? OR narrative LIKE ? OR text LIKE ?)"
      params.push(likeTerm, likeTerm, likeTerm)
    }
    if (opts.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(",")})`
      params.push(...opts.types)
    }
    if (opts.concepts && opts.concepts.length > 0) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(concepts) WHERE value IN (${opts.concepts.map(() => "?").join(",")}))`
      params.push(...opts.concepts)
    }

    sql += " ORDER BY time_created DESC LIMIT ?"
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as ObservationRow[]
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      narrative: row.narrative,
      facts: row.facts,
      concepts: row.concepts,
      score: 1,
      time_created: row.time_created,
    }))
  }

  createSummary(input: SummaryInput): { id: number; timeCreated: number } {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO session_summary
        (memory_session_id, project, request, investigated, learned, completed, next_steps, notes, discovery_tokens, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, time_created
    `)

    const row = stmt.get(
      input.memory_session_id,
      input.project,
      input.request ?? null,
      input.investigated ?? null,
      input.learned ?? null,
      input.completed ?? null,
      input.next_steps ?? null,
      input.notes ?? null,
      input.discovery_tokens ?? 0,
      now,
    ) as { id: number; time_created: number }

    return { id: row.id, timeCreated: row.time_created }
  }

  getRecentSummaries(limit: number = 5): SummaryRow[] {
    return this.db
      .prepare(
        "SELECT * FROM session_summary ORDER BY time_created DESC LIMIT ?",
      )
      .all(limit) as SummaryRow[]
  }

  getObservationsBySession(sessionId: string, limit: number = 20): ObservationRow[] {
    return this.db
      .prepare(
        "SELECT * FROM observation WHERE memory_session_id = ? ORDER BY time_created DESC LIMIT ?",
      )
      .all(sessionId, limit) as ObservationRow[]
  }

  getObservationCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM observation").get() as { count: number }
    return row.count
  }

  close(): void {
    this.db.close()
  }
}

let instance: MemoryDb | undefined

export function getMemoryDb(): MemoryDb {
  if (!instance) {
    instance = new MemoryDb()
  }
  return instance
}

export function resetMemoryDb(): void {
  if (instance) {
    instance.close()
    instance = undefined
  }
}
