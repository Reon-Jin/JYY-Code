import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type SnapshotManifestEntry = {
  relative_path: string
  hash: string
  size: number
  mtime_ms?: number
  mode: "file" | "symlink"
}

export type SnapshotManifestLimits = {
  maxFileBytes: number
  maxTotalBytes: number
  maxFileCount: number
}

export const DEFAULT_SNAPSHOT_MANIFEST_LIMITS: SnapshotManifestLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileCount: 50_000,
}

export type SnapshotManifest = {
  version: 1
  source_root: string
  source_manifest_hash: string
  entries: SnapshotManifestEntry[]
  file_count: number
  total_bytes: number
}

export type SnapshotManifestOptions = {
  root: string
  runtimeRoot?: string
  limits?: Partial<SnapshotManifestLimits>
  exclude?: readonly string[]
  include?: readonly string[]
}

const NEVER_INCLUDE = new Set([".git", ".jyycode"])
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".jyycode",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  "target",
])

function normalize(relative: string) {
  return relative.replaceAll("\\", "/").replace(/^\.\//, "")
}

const patternCache = new Map<string, RegExp>()

function compiled(pattern: string) {
  const cached = patternCache.get(pattern)
  if (cached) return cached
  const source = normalize(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "@@DOUBLE_STAR@@")
    .replaceAll("*", "[^/]*")
    .replaceAll("@@DOUBLE_STAR@@", ".*")
    .replaceAll("?", "[^/]")
  const regex = new RegExp(`^${source}(?:/|$)`)
  patternCache.set(pattern, regex)
  return regex
}

function matches(pattern: string, relative: string) {
  return compiled(pattern).test(relative)
}

function hardExcluded(relative: string) {
  return normalize(relative)
    .split("/")
    .some((part) => DEFAULT_EXCLUDED_DIRECTORIES.has(part.toLowerCase()))
}

function gitIgnorePatterns(root: string) {
  const pathname = path.join(root, ".gitignore")
  if (!fs.existsSync(pathname)) return []
  return fs
    .readFileSync(pathname, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => line.replace(/^\/+/, "").replace(/\/$/, ""))
}

export function isSnapshotPathIncluded(
  relative: string,
  options: Pick<SnapshotManifestOptions, "exclude" | "include"> = {},
  gitignore: readonly string[] = [],
) {
  const normalized = normalize(relative)
  const hard = normalized.split("/").some((part) => NEVER_INCLUDE.has(part))
  if (hard || hardExcluded(normalized)) {
    if (hard) return false
    return options.include?.some((pattern) => matches(pattern, normalized)) === true && !hard
  }
  if (
    gitignore.some((pattern) => matches(pattern, normalized)) &&
    !options.include?.some((pattern) => matches(pattern, normalized))
  )
    return false
  if (options.exclude?.some((pattern) => matches(pattern, normalized)))
    return options.include?.some((pattern) => matches(pattern, normalized)) === true
  return true
}

/** Test-only counter proving the persistent manifest hash cache avoids re-reads. */
export const __snapshotHashStats = { filesRead: 0 }

async function hashFile(pathname: string, limits: SnapshotManifestLimits, size: number) {
  if (size > limits.maxFileBytes)
    throw new Error(`snapshot file exceeds the per-file limit (${size} > ${limits.maxFileBytes})`)
  __snapshotHashStats.filesRead++
  const hash = crypto.createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(pathname)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve())
  })
  return hash.digest("hex")
}

/** Hash file bodies with bounded parallelism instead of one serial await per file. */
export const HASH_CONCURRENCY = 8

export async function mapConcurrent<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker))
  return results
}

/**
 * Persistent per-runtime hash cache. Re-hashing every file on every dispatch
 * is the dominant cost on large repositories; a file whose size, mtime, and
 * mode are unchanged reuses its previous sha256.
 */
export type ManifestHashCache = {
  version: 1
  entries: Record<string, { size: number; mtime_ms: number; mode: "file" | "symlink"; hash: string }>
}

function manifestCachePath(runtimeRoot: string, root: string) {
  const scope = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)
  return path.join(runtimeRoot, `.source-manifest-cache-${scope}.json`)
}

export function readManifestHashCache(runtimeRoot: string, root: string): ManifestHashCache {
  try {
    const value = JSON.parse(fs.readFileSync(manifestCachePath(runtimeRoot, root), "utf8")) as ManifestHashCache
    if (value?.version === 1 && value.entries && typeof value.entries === "object") return value
  } catch {
    // A missing or corrupt cache only makes the next dispatch slower.
  }
  return { version: 1, entries: {} }
}

export function removeManifestHashCache(runtimeRoot: string, root: string) {
  try {
    fs.rmSync(manifestCachePath(runtimeRoot, root), { force: true })
  } catch {
    // Best effort cleanup; a leftover cache file is harmless.
  }
}

export function writeManifestHashCache(runtimeRoot: string, root: string, cache: ManifestHashCache) {
  const target = manifestCachePath(runtimeRoot, root)
  const staging = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`
  try {
    fs.writeFileSync(staging, JSON.stringify(cache), "utf8")
    fs.renameSync(staging, target)
  } catch {
    try {
      fs.rmSync(staging, { force: true })
    } catch {
      // Best effort; a cache write failure must never fail a dispatch.
    }
  }
}

type PendingHash = { entry: SnapshotManifestEntry; pathname: string; size: number; mtimeMs: number }

async function walk(
  root: string,
  current: string,
  options: Required<Pick<SnapshotManifestOptions, "exclude" | "include">> & {
    runtimeRoot?: string
    gitignore: readonly string[]
  },
  limits: SnapshotManifestLimits,
  entries: SnapshotManifestEntry[],
  totals: { bytes: number },
  pending: PendingHash[],
) {
  const dirents = await fs.promises.readdir(current, { withFileTypes: true })
  for (const entry of dirents) {
    const pathname = path.join(current, entry.name)
    const relative = normalize(path.relative(root, pathname))
    if (!relative || hardExcluded(relative)) continue
    if (options.runtimeRoot && path.resolve(pathname) === path.resolve(options.runtimeRoot)) continue
    if (entry.isDirectory()) {
      if (isSnapshotPathIncluded(relative, options, options.gitignore))
        await walk(root, pathname, options, limits, entries, totals, pending)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!isSnapshotPathIncluded(relative, options, options.gitignore)) continue
    const stat = await fs.promises.lstat(pathname)
    if (entry.isSymbolicLink()) {
      const target = await fs.promises.readlink(pathname)
      const size = Buffer.byteLength(target)
      entries.push({ relative_path: relative, hash: target, size, mtime_ms: stat.mtimeMs, mode: "symlink" })
      totals.bytes += size
    } else {
      if (stat.size > limits.maxFileBytes)
        throw new Error(`snapshot file exceeds the per-file limit (${stat.size} > ${limits.maxFileBytes})`)
      const record: SnapshotManifestEntry = {
        relative_path: relative,
        hash: "",
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        mode: "file",
      }
      entries.push(record)
      pending.push({ entry: record, pathname, size: stat.size, mtimeMs: stat.mtimeMs })
      totals.bytes += stat.size
    }
    if (entries.length > limits.maxFileCount)
      throw new Error(`snapshot contains too many files (${entries.length} > ${limits.maxFileCount})`)
    if (totals.bytes > limits.maxTotalBytes)
      throw new Error(`snapshot exceeds the total-byte limit (${totals.bytes} > ${limits.maxTotalBytes})`)
  }
}

export function snapshotManifestHash(entries: readonly SnapshotManifestEntry[]) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

export async function buildSnapshotManifest(input: SnapshotManifestOptions): Promise<SnapshotManifest> {
  const root = path.resolve(input.root)
  const limits = { ...DEFAULT_SNAPSHOT_MANIFEST_LIMITS, ...input.limits }
  const entries: SnapshotManifestEntry[] = []
  const pending: PendingHash[] = []
  const gitignore = gitIgnorePatterns(root)
  const totals = { bytes: 0 }
  await walk(
    root,
    root,
    { exclude: input.exclude ?? [], include: input.include ?? [], runtimeRoot: input.runtimeRoot, gitignore },
    limits,
    entries,
    totals,
    pending,
  )
  const cache = input.runtimeRoot ? readManifestHashCache(input.runtimeRoot, root) : undefined
  const nextCache: ManifestHashCache["entries"] = {}
  await mapConcurrent(pending, HASH_CONCURRENCY, async (item) => {
    const cached = cache?.entries[item.entry.relative_path]
    item.entry.hash =
      cached && cached.size === item.size && cached.mtime_ms === item.mtimeMs && cached.mode === "file"
        ? cached.hash
        : await hashFile(item.pathname, limits, item.size)
    nextCache[item.entry.relative_path] = {
      size: item.size,
      mtime_ms: item.mtimeMs,
      mode: "file",
      hash: item.entry.hash,
    }
  })
  if (cache && input.runtimeRoot) writeManifestHashCache(input.runtimeRoot, root, { version: 1, entries: nextCache })
  entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  return {
    version: 1,
    source_root: root,
    source_manifest_hash: snapshotManifestHash(entries),
    entries,
    file_count: entries.length,
    total_bytes: totals.bytes,
  }
}

export * as SnapshotManifestModule from "./snapshot-manifest"
