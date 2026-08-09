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

function matches(pattern: string, relative: string) {
  const source = normalize(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "@@DOUBLE_STAR@@")
    .replaceAll("*", "[^/]*")
    .replaceAll("@@DOUBLE_STAR@@", ".*")
    .replaceAll("?", "[^/]")
  return new RegExp(`^${source}(?:/|$)`).test(relative)
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

async function hashFile(pathname: string, limits: SnapshotManifestLimits, size: number) {
  if (size > limits.maxFileBytes)
    throw new Error(`snapshot file exceeds the per-file limit (${size} > ${limits.maxFileBytes})`)
  const hash = crypto.createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(pathname)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve())
  })
  return hash.digest("hex")
}

async function walk(
  root: string,
  current: string,
  options: Required<Pick<SnapshotManifestOptions, "exclude" | "include">> & {
    runtimeRoot?: string
    gitignore: readonly string[]
  },
  limits: SnapshotManifestLimits,
  entries: SnapshotManifestEntry[],
) {
  const dirents = await fs.promises.readdir(current, { withFileTypes: true })
  for (const entry of dirents) {
    const pathname = path.join(current, entry.name)
    const relative = normalize(path.relative(root, pathname))
    if (!relative || hardExcluded(relative)) continue
    if (options.runtimeRoot && path.resolve(pathname) === path.resolve(options.runtimeRoot)) continue
    if (entry.isDirectory()) {
      if (isSnapshotPathIncluded(relative, options, options.gitignore))
        await walk(root, pathname, options, limits, entries)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!isSnapshotPathIncluded(relative, options, options.gitignore)) continue
    const stat = await fs.promises.lstat(pathname)
    if (entry.isSymbolicLink()) {
      const target = await fs.promises.readlink(pathname)
      entries.push({
        relative_path: relative,
        hash: target,
        size: Buffer.byteLength(target),
        mtime_ms: stat.mtimeMs,
        mode: "symlink",
      })
    } else {
      entries.push({
        relative_path: relative,
        hash: await hashFile(pathname, limits, stat.size),
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        mode: "file",
      })
    }
    if (entries.length > limits.maxFileCount)
      throw new Error(`snapshot contains too many files (${entries.length} > ${limits.maxFileCount})`)
    const total = entries.reduce((sum, item) => sum + item.size, 0)
    if (total > limits.maxTotalBytes)
      throw new Error(`snapshot exceeds the total-byte limit (${total} > ${limits.maxTotalBytes})`)
  }
}

export function snapshotManifestHash(entries: readonly SnapshotManifestEntry[]) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

export async function buildSnapshotManifest(input: SnapshotManifestOptions): Promise<SnapshotManifest> {
  const root = path.resolve(input.root)
  const limits = { ...DEFAULT_SNAPSHOT_MANIFEST_LIMITS, ...input.limits }
  const entries: SnapshotManifestEntry[] = []
  const gitignore = gitIgnorePatterns(root)
  await walk(
    root,
    root,
    { exclude: input.exclude ?? [], include: input.include ?? [], runtimeRoot: input.runtimeRoot, gitignore },
    limits,
    entries,
  )
  entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  return {
    version: 1,
    source_root: root,
    source_manifest_hash: snapshotManifestHash(entries),
    entries,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, item) => sum + item.size, 0),
  }
}

export * as SnapshotManifestModule from "./snapshot-manifest"
