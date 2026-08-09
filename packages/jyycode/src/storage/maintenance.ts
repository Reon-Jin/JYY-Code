import { maintainNative, type MaintenanceResult } from "@jyycode-ai/core/database/database"
import { Global } from "@jyycode-ai/core/global"
import { Effect } from "effect"
import { Database } from "@/storage/db"
import { Database as BunDatabase } from "bun:sqlite"
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export type MaintenanceOptions = {
  readonly dryRun?: boolean
  readonly full?: boolean
  readonly maxVacuumPages?: number
}

export type MaintenanceReport = {
  readonly path: string
  readonly status: "dry-run" | "completed" | "busy" | "insufficient-space"
  readonly mode: "bounded" | "full"
  readonly result?: MaintenanceResult
  readonly manifest?: string
  readonly reason?: string
}

function integrity(native: BunDatabase) {
  const row = native.query("PRAGMA integrity_check(1)").get() as Record<string, unknown> | null
  return row ? String(Object.values(row)[0] ?? "unknown") : "unknown"
}

async function freeBytes(directory: string) {
  const info = await statfs(directory)
  return Number(info.bavail) * Number(info.bsize)
}

async function fullVacuum(file: string, options: MaintenanceOptions): Promise<MaintenanceReport> {
  const resolved = path.resolve(file)
  const directory = path.dirname(resolved)
  const source = await stat(resolved)
  const minimumFree = Math.max(64 * 1024 * 1024, source.size * 2)
  const available = await freeBytes(directory).catch(() => 0)
  if (available < minimumFree) {
    return { path: resolved, status: "insufficient-space", mode: "full", reason: `need ${minimumFree} bytes, have ${available}` }
  }
  if (options.dryRun) {
    return { path: resolved, status: "dry-run", mode: "full", reason: `would require at least ${minimumFree} free bytes` }
  }

  const temp = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.vacuum.tmp`)
  const manifest = `${resolved}.vacuum-manifest.json`
  let native: BunDatabase | undefined
  try {
    native = new BunDatabase(resolved, { readwrite: true, create: false })
    native.query("VACUUM INTO ?").run(temp)
    native.close(false)
    native = undefined

    const candidate = new BunDatabase(temp, { readonly: true, create: false })
    const check = integrity(candidate)
    candidate.close(false)
    if (check !== "ok") throw new Error(`vacuum candidate failed integrity check: ${check}`)

    const manifestTemp = `${manifest}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(
      manifestTemp,
      JSON.stringify(
        {
          version: 1,
          source: resolved,
          sourceBytes: source.size,
          candidate: temp,
          integrity: check,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    await rename(manifestTemp, manifest)

    if (process.platform === "win32") {
      return { path: resolved, status: "busy", mode: "full", manifest, reason: "Windows replacement is refused while database handles may be open" }
    }
    await rename(temp, resolved)
    return { path: resolved, status: "completed", mode: "full", manifest }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const busy = process.platform === "win32" || /busy|locked|access|used/i.test(message)
    return { path: resolved, status: busy ? "busy" : "insufficient-space", mode: "full", reason: message }
  } finally {
    native?.close(false)
    await rm(temp, { force: true }).catch(() => undefined)
    if (!(await stat(resolved).catch(() => undefined))) await rm(resolved, { force: true }).catch(() => undefined)
  }
}

export function maintainActiveDatabase(options: MaintenanceOptions = {}) {
  return Effect.gen(function* () {
    const service = yield* Database.Service
    const file = Database.getPath()
    if (options.full) {
      return {
        path: file,
        status: "busy" as const,
        mode: "full" as const,
        reason: "active database is owned by the running process; use an offline copy for full VACUUM",
      }
    }
    const result = maintainNative(service.native, options)
    return {
      path: file,
      status: options.dryRun ? ("dry-run" as const) : ("completed" as const),
      mode: "bounded" as const,
      result,
    }
  })
}

export async function maintainDatabase(file: string, options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const resolved = path.resolve(file)
  if (options.full) return fullVacuum(resolved, options)
  const native = new BunDatabase(resolved, { readwrite: true, create: false })
  try {
    const result = maintainNative(native, options)
    return { path: resolved, status: options.dryRun ? "dry-run" : "completed", mode: "bounded", result }
  } finally {
    native.close(false)
  }
}

export function activeDatabasePath() {
  return Database.getPath()
}

export const defaultMaintenanceRoot = () => Global.Path.data
