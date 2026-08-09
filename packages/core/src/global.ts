import path from "path"
import fs from "fs/promises"
import { rmSync } from "node:fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"

const app = "jyycode"
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmpRoot = path.join(os.tmpdir(), app)
const tmp = path.join(tmpRoot, `process-${process.pid}`)
const PROCESS_TMP = /^process-(\d+)$/

function processIsAlive(pid: number) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

async function cleanupStaleTempDirectories() {
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isDirectory()) return []
      const match = entry.name.match(PROCESS_TMP)
      if (!match) return []
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || processIsAlive(pid)) return []
      return [fs.rm(path.join(tmpRoot, entry.name), { recursive: true, force: true }).catch(() => {})]
    }),
  )
}

async function ensurePrivateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === "win32") return
  const stat = await fs.lstat(directory).catch(() => undefined)
  if (stat?.isDirectory()) await fs.chmod(directory, 0o700).catch(() => {})
}

const paths = {
  get home() {
    return process.env.JYYCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await fs.rm(Path.tmp, { recursive: true, force: true })
await cleanupStaleTempDirectories()

await Promise.all([
  ensurePrivateDirectory(Path.data),
  ensurePrivateDirectory(Path.config),
  ensurePrivateDirectory(Path.state),
  ensurePrivateDirectory(Path.tmp),
  ensurePrivateDirectory(Path.log),
  ensurePrivateDirectory(Path.bin),
  ensurePrivateDirectory(Path.repos),
])

// `Path.tmp` is intentionally process-scoped. A synchronous exit hook covers
// normal exits, signal exits, and uncaught failures without keeping the
// process alive just to finish asynchronous cleanup.
process.once("exit", () => {
  try {
    rmSync(Path.tmp, { recursive: true, force: true })
  } catch {
    // Best effort only: a child process may still hold a file open on Windows.
  }
})

export class Service extends Context.Service<Service, Interface>()("@jyycode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.JYYCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
