import type { Argv } from "yargs"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@jyycode-ai/core/process"
import { AppRuntime } from "@/effect/app-runtime"
import { Database } from "@/storage/db"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"
import { existsSync, readdirSync, statSync } from "fs"
import path from "path"
import type { RuntimeFlags } from "@/effect/runtime-flags"

type StatusFlags = Pick<RuntimeFlags.Info, "disableChannelDb">

export interface DatabaseCounts {
  sessions: number
  projects: number
  messages: number
  parts: number
  migrations: number
}

export interface DatabaseStatus {
  active: ReturnType<typeof Database.describePath> & {
    exists: boolean
    size: number
    counts: DatabaseCounts
    error?: string
  }
  databases: Array<{ path: string; size: number; sessions: number; error?: string }>
  hint?: string
}

function tableExists(db: BunDatabase, table: string) {
  return db.query("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== null
}

function tableCount(db: BunDatabase, table: string) {
  if (!tableExists(db, table)) return 0
  return Number((db.query(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number | bigint }).count)
}

function fileSize(file: string) {
  return existsSync(file) ? statSync(file).size : 0
}

function activeCounts(file: string): { counts: DatabaseCounts; error?: string } {
  const empty = { sessions: 0, projects: 0, messages: 0, parts: 0, migrations: 0 }
  if (!existsSync(file)) return { counts: empty }
  const db = new BunDatabase(file, { readonly: true })
  try {
    return {
      counts: {
        sessions: tableCount(db, "session"),
        projects: tableCount(db, "project"),
        messages: tableCount(db, "message"),
        parts: tableCount(db, "part"),
        migrations: tableExists(db, "migration") ? tableCount(db, "migration") : tableCount(db, "__drizzle_migrations"),
      },
    }
  } catch (error) {
    return { counts: empty, error: errorMessage(error) }
  } finally {
    db.close()
  }
}

function discoveredDatabase(file: string) {
  const db = new BunDatabase(file, { readonly: true })
  try {
    return { path: file, size: fileSize(file), sessions: tableCount(db, "session") }
  } catch (error) {
    return { path: file, size: fileSize(file), sessions: 0, error: errorMessage(error) }
  } finally {
    db.close()
  }
}

export function collectDatabaseStatus(flags?: StatusFlags): DatabaseStatus {
  const selection = Database.describePath(flags)
  const activeResult = activeCounts(selection.path)
  const directory = path.dirname(selection.path)
  const databases = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^jyycode.*\.db$/i.test(entry.name))
        .map((entry) => path.join(directory, entry.name))
        .filter((file) => path.resolve(file) !== path.resolve(selection.path))
        .map(discoveredDatabase)
        .toSorted((a, b) => a.path.localeCompare(b.path))
    : []
  const hint =
    activeResult.counts.sessions === 0 && databases.some((item) => item.sessions > 0)
      ? "Another channel database contains sessions. Set JYYCODE_DISABLE_CHANNEL_DB=1 only after backing up databases and confirming schema compatibility."
      : undefined

  return {
    active: {
      ...selection,
      exists: existsSync(selection.path),
      size: fileSize(selection.path),
      counts: activeResult.counts,
      ...(activeResult.error ? { error: activeResult.error } : {}),
    },
    databases,
    ...(hint ? { hint } : {}),
  }
}

function formatSize(size: number) {
  return `${size.toLocaleString("en-US")} bytes`
}

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new BunDatabase(Database.getPath(), { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => row[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      }
      db.close()
      return
    }
    const exitCode = await AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const appProcess = yield* AppProcess.Service
          const child = yield* appProcess.spawn(
            ChildProcess.make("sqlite3", [Database.getPath()], {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }),
          )
          return yield* child.exitCode
        }),
      ),
    )
    if (exitCode !== 0) process.exitCode = exitCode
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.getPath())
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show the active database and discovered channel databases",
  handler: () => {
    const status = collectDatabaseStatus()
    UI.println(`Active database: ${status.active.path}`)
    UI.println(`Channel: ${status.active.channel}`)
    UI.println(`Selection source: ${status.active.source}`)
    UI.println(`Exists: ${status.active.exists ? "yes" : "no"}`)
    UI.println(`Size: ${formatSize(status.active.size)}`)
    UI.println(
      `Rows: ${status.active.counts.sessions} sessions, ${status.active.counts.projects} projects, ${status.active.counts.messages} messages, ${status.active.counts.parts} parts`,
    )
    UI.println(`Applied migrations: ${status.active.counts.migrations}`)
    if (status.active.error) UI.println(`Read error: ${status.active.error}`)
    for (const item of status.databases) {
      UI.println(`Other database: ${item.path} (${formatSize(item.size)}, ${item.sessions} sessions)`)
      if (item.error) UI.println(`  Read error: ${item.error}`)
    }
    if (status.hint) UI.println(`Hint: ${status.hint}`)
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const sqlite = new BunDatabase(Database.getPath())
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      sqlite.close()
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(StatusCommand)
      .command(MigrateCommand)
      .demandCommand()
  },
  handler: () => {},
})
