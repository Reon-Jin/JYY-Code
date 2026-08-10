import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_SNAPSHOT_LIMITS,
  isSnapshotPathAllowed,
  type BaselineManifestEntry,
  type SnapshotLimits,
} from "./child-workspace"
import type { MergeConflictKind, MergeConflictSummary, MergeResolution } from "./schema"

const INTERNAL_NAMES = new Set([".git", ".jyycode"])
const MAX_PATH_LENGTH = 4096

export type WorkspaceMergeInput = {
  base: string
  main: string
  child: string
  paths?: string[]
  resolutions?: MergeResolution[]
  childManifest?: BaselineManifestEntry[]
  childLimits?: SnapshotLimits
}

export type MergeApplyEntry = {
  path: string
  kind: "file" | "symlink"
  source: "child" | "merged"
  content?: string
  bytes?: Uint8Array
  link?: string
}

export type MergePlan = {
  apply: MergeApplyEntry[]
  keep: string[]
  delete: string[]
  conflicts: MergeConflictSummary[]
}

export type WorkspaceMergePreparation = {
  roots: { base: string; main: string; child: string }
  base: Map<string, FileEntry>
  main: Map<string, FileEntry>
  child: Map<string, FileEntry>
  plan: MergePlan
}

export type WorkspaceMergeTransactionInput = WorkspaceMergeInput & {
  journal_directory: string
}

export type WorkspaceMergeTransactionOptions = {
  beforeApply?: () => void
  failAfterWrites?: number
  interruptAfterWrites?: number
}

export type WorkspaceMergeTransactionResult = {
  status: "merged" | "already_merged" | "conflict" | "failed" | "stale"
  applied_paths: string[]
  conflicts: MergeConflictSummary[]
  plan: MergePlan
  journal_path: string
  target_fingerprint: string
  error?: string
}

export type FileEntry = {
  path: string
  kind: "file" | "symlink"
  hash: string
  bytes?: Uint8Array
  text?: string
  link?: string
}

type ChangeHunk = {
  start: number
  end: number
  replacement: string[]
}

function fail(message: string): never {
  throw new WorkspaceMergeError(message)
}

export class WorkspaceMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceMergeError"
  }
}

function hashBytes(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function entryFingerprint(entry: FileEntry | undefined) {
  return entry ? `${entry.kind}:${entry.hash}` : null
}

function planEntryFingerprint(entry: MergeApplyEntry | undefined) {
  if (!entry) return null
  if (entry.kind === "symlink") return `symlink:${hashText(entry.link ?? "")}`
  if (entry.content !== undefined) return `file:${hashText(entry.content)}`
  return `file:${hashBytes(entry.bytes ?? new Uint8Array())}`
}

function normalizeText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function isTextBytes(bytes: Uint8Array) {
  if (bytes.includes(0)) return false
  try {
    const text = Buffer.from(bytes).toString("utf8")
    return Buffer.from(text, "utf8").equals(Buffer.from(bytes))
  } catch {
    return false
  }
}

function canonicalRelative(value: string, field = "path") {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) fail(`${field} is invalid`)
  const slash = value.replaceAll("\\", "/")
  if (slash.startsWith("/") || slash.startsWith("//") || /^[A-Za-z]:\//.test(slash)) fail(`${field} must be relative`)
  const parts = slash.split("/")
  if (parts.some((part) => part === ".." || (part === "" && parts.length > 1))) fail(`${field} escapes the workspace`)
  if (parts.some((part) => INTERNAL_NAMES.has(part))) fail(`${field} targets internal runtime metadata`)
  if (parts.some((part) => part === ".")) fail(`${field} contains an ambiguous segment`)
  return parts.join("/")
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function removeMergeJournal(journalDirectory: string, runtimeRoot: string) {
  const root = path.resolve(runtimeRoot)
  const directory = path.resolve(journalDirectory)
  if (directory === root || !isWithin(root, directory)) fail("merge journal is outside the owning runtime root")
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
}

function canonicalRoot(value: string, field: string) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} is required`)
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) fail(`${field} must be an existing directory`)
  return fs.realpathSync.native(resolved)
}

function assertSafeLink(root: string, pathname: string) {
  const target = fs.readlinkSync(pathname)
  const resolved = path.resolve(path.dirname(pathname), target)
  if (!isWithin(root, resolved)) fail(`symlink escapes its workspace: ${path.relative(root, pathname)}`)
  return target
}

type ScanOptions = {
  childSnapshot?: boolean
  limits?: SnapshotLimits
  state?: { totalBytes: number; fileCount: number }
}

function scanWorkspace(root: string, current = root, output = new Map<string, FileEntry>(), options: ScanOptions = {}) {
  const state = options.state ?? { totalBytes: 0, fileCount: 0 }
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (INTERNAL_NAMES.has(entry.name)) continue
    const pathname = path.join(current, entry.name)
    const relative = canonicalRelative(path.relative(root, pathname), "workspace path")
    if (entry.isDirectory()) {
      if (options.childSnapshot && !isSnapshotPathAllowed(relative, true)) continue
      scanWorkspace(root, pathname, output, { ...options, state })
      continue
    }
    if (options.childSnapshot && !isSnapshotPathAllowed(relative)) continue
    if (entry.isSymbolicLink()) {
      const link = assertSafeLink(root, pathname)
      const size = Buffer.byteLength(link)
      if (options.limits) {
        if (size > options.limits.maxFileBytes) fail(`child merge file exceeds the per-file limit: ${relative}`)
        state.totalBytes += size
        state.fileCount++
        if (state.totalBytes > options.limits.maxTotalBytes)
          fail("child merge exceeds the total-byte limit; narrow the task scope")
        if (state.fileCount > options.limits.maxFileCount)
          fail("child merge exceeds the file-count limit; narrow the task scope")
      }
      output.set(relative, { path: relative, kind: "symlink", link, hash: hashText(link) })
      continue
    }
    if (!entry.isFile()) fail(`unsupported workspace entry: ${relative}`)
    if (options.limits) {
      const size = fs.statSync(pathname).size
      if (size > options.limits.maxFileBytes) fail(`child merge file exceeds the per-file limit: ${relative}`)
      state.totalBytes += size
      state.fileCount++
      if (state.totalBytes > options.limits.maxTotalBytes)
        fail("child merge exceeds the total-byte limit; narrow the task scope")
      if (state.fileCount > options.limits.maxFileCount)
        fail("child merge exceeds the file-count limit; narrow the task scope")
    }
    const bytes = new Uint8Array(fs.readFileSync(pathname))
    const text = isTextBytes(bytes) ? Buffer.from(bytes).toString("utf8") : undefined
    output.set(relative, {
      path: relative,
      kind: "file",
      hash: hashBytes(bytes),
      bytes,
      ...(text !== undefined ? { text } : {}),
    })
  }
  return output
}

function sameEntry(left: FileEntry | undefined, right: FileEntry | undefined) {
  if (!left || !right) return !left && !right
  if (left.kind !== right.kind) return false
  if (left.kind === "symlink" || right.kind === "symlink") return left.hash === right.hash
  if (left.text !== undefined && right.text !== undefined) return normalizeText(left.text) === normalizeText(right.text)
  return left.hash === right.hash
}

function entryIsBinary(entry: FileEntry | undefined) {
  return !!entry && entry.kind === "file" && entry.text === undefined
}

function readEntry(entry: FileEntry | undefined): MergeApplyEntry | undefined {
  if (!entry) return undefined
  if (entry.kind === "symlink") return { path: entry.path, kind: "symlink", source: "child", link: entry.link }
  if (entry.text !== undefined) return { path: entry.path, kind: "file", source: "child", content: entry.text }
  return { path: entry.path, kind: "file", source: "child", bytes: entry.bytes }
}

function splitLines(text: string) {
  const normalized = normalizeText(text)
  const trailing = normalized.endsWith("\n")
  const lines = normalized.split("\n")
  if (trailing) lines.pop()
  return { lines, trailing }
}

function lineHunks(baseText: string, sideText: string): ChangeHunk[] {
  const base = splitLines(baseText).lines
  const side = splitLines(sideText).lines
  const rows = Array.from({ length: base.length + 1 }, () => new Uint32Array(side.length + 1))
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = side.length - 1; j >= 0; j--)
      rows[i]![j] = base[i] === side[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!)
  }
  const hunks: ChangeHunk[] = []
  let i = 0
  let j = 0
  while (i < base.length || j < side.length) {
    if (i < base.length && j < side.length && base[i] === side[j]) {
      i++
      j++
      continue
    }
    const start = i
    const replacement: string[] = []
    while (i < base.length || j < side.length) {
      if (i < base.length && j < side.length && base[i] === side[j]) break
      if (j < side.length && (i === base.length || rows[i]![j + 1]! >= rows[i + 1]![j]!)) {
        replacement.push(side[j]!)
        j++
      } else i++
    }
    hunks.push({ start, end: i, replacement })
  }
  return hunks
}

function hunkOverlap(left: ChangeHunk, right: ChangeHunk) {
  if (left.start === left.end && right.start === right.end) return left.start === right.start
  if (left.start === left.end) return left.start >= right.start && left.start <= right.end
  if (right.start === right.end) return right.start >= left.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}

function renderMergedText(baseText: string, mainText: string, childText: string) {
  const base = splitLines(baseText)
  const main = splitLines(mainText)
  const child = splitLines(childText)
  const mainHunks = lineHunks(baseText, mainText)
  const childHunks = lineHunks(baseText, childText)
  for (const left of mainHunks) {
    for (const right of childHunks) {
      if (hunkOverlap(left, right)) {
        if (
          left.start === right.start &&
          left.end === right.end &&
          left.replacement.join("\n") === right.replacement.join("\n")
        )
          continue
        return undefined
      }
    }
  }
  const hunks = [...mainHunks.map((hunk) => ({ ...hunk })), ...childHunks.map((hunk) => ({ ...hunk }))].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
  const lines = base.lines.slice()
  let offset = 0
  for (const hunk of hunks) {
    const start = hunk.start + offset
    lines.splice(start, hunk.end - hunk.start, ...hunk.replacement)
    offset += hunk.replacement.length - (hunk.end - hunk.start)
  }
  const newline = mainText.includes("\r\n") ? "\r\n" : childText.includes("\r\n") ? "\r\n" : "\n"
  return lines.join(newline) + (base.trailing || main.trailing || child.trailing ? newline : "")
}

function conflictKind(
  base: FileEntry | undefined,
  main: FileEntry | undefined,
  child: FileEntry | undefined,
): MergeConflictKind {
  if (base?.kind === "symlink" || main?.kind === "symlink" || child?.kind === "symlink") return "symlink"
  if (!base && main && child) return "add_add"
  if (base && (!main || !child)) return "delete_modify"
  if (entryIsBinary(base) || entryIsBinary(main) || entryIsBinary(child)) return "binary"
  return "content"
}

function conflictSummary(
  relative: string,
  kind: MergeConflictKind,
  roots: { base: string; main: string; child: string },
  base: FileEntry | undefined,
  main: FileEntry | undefined,
  child: FileEntry | undefined,
): MergeConflictSummary {
  return {
    path: relative,
    kind,
    ...(main ? { main_path: path.join(roots.main, relative.replaceAll("/", path.sep)) } : {}),
    ...(child ? { child_path: path.join(roots.child, relative.replaceAll("/", path.sep)) } : {}),
    ...(base ? { base_path: path.join(roots.base, relative.replaceAll("/", path.sep)) } : {}),
    // Keep the fingerprint stable when the parent edits the conflicted file
    // between attempts. The base/child pair is the merge input that a
    // resolution is authorizing; a changed child must invalidate that retry.
    fingerprint: hashText(`${kind}\0${base?.hash ?? ""}\0${child?.hash ?? ""}`),
  }
}

function applyEntryFrom(
  entry: FileEntry | undefined,
  source: "child" | "merged",
  content?: string,
): MergeApplyEntry | undefined {
  if (!entry) return undefined
  if (entry.kind === "symlink") return { path: entry.path, kind: "symlink", source, link: entry.link }
  if (content !== undefined) return { path: entry.path, kind: "file", source, content }
  if (entry.text !== undefined) return { path: entry.path, kind: "file", source, content: entry.text }
  return { path: entry.path, kind: "file", source, bytes: entry.bytes }
}

function inScope(relative: string, scopes: string[]) {
  return scopes.length === 0 || scopes.some((scope) => relative === scope || relative.startsWith(`${scope}/`))
}

export function prepareWorkspaceMerge(input: WorkspaceMergeInput): WorkspaceMergePreparation {
  const roots = {
    base: canonicalRoot(input.base, "base"),
    main: canonicalRoot(input.main, "main"),
    child: canonicalRoot(input.child, "child"),
  }
  const scopes = (input.paths ?? []).map((value) => canonicalRelative(value, "paths entry"))
  const resolutions = new Map<string, MergeResolution>()
  for (const resolution of input.resolutions ?? []) {
    const relative = canonicalRelative(resolution.path, "resolution path")
    if (resolution.use !== "main" && resolution.use !== "child") fail(`invalid resolution for ${relative}`)
    if (resolutions.has(relative)) fail(`duplicate resolution for ${relative}`)
    resolutions.set(relative, { path: relative, use: resolution.use })
  }
  const base = scanWorkspace(roots.base)
  const main = scanWorkspace(roots.main)
  const child = scanWorkspace(roots.child, roots.child, new Map(), {
    childSnapshot: input.childManifest !== undefined,
    limits: input.childLimits ?? (input.childManifest !== undefined ? DEFAULT_SNAPSHOT_LIMITS : undefined),
  })
  if (input.childManifest) {
    for (const entry of input.childManifest) {
      const relative = entry.relative_path.replaceAll("\\", "/")
      const baseline = base.get(relative)
      const expected = entry.mode === "symlink" ? hashText(entry.hash) : entry.hash
      if (!baseline || baseline.kind !== entry.mode || baseline.hash !== expected)
        fail(`baseline manifest does not match the recorded snapshot: ${relative}`)
    }
  }
  const allPaths = [...new Set([...base.keys(), ...main.keys(), ...child.keys()])]
    .filter((relative) => inScope(relative, scopes))
    .sort((left, right) => left.localeCompare(right))
  const result: MergePlan = { apply: [], keep: [], delete: [], conflicts: [] }
  const conflictPaths = new Set<string>()

  for (const relative of allPaths) {
    const baseEntry = base.get(relative)
    const mainEntry = main.get(relative)
    const childEntry = child.get(relative)
    if (sameEntry(mainEntry, baseEntry)) {
      if (sameEntry(childEntry, baseEntry)) result.keep.push(relative)
      else if (childEntry) result.apply.push(applyEntryFrom(childEntry, "child")!)
      else result.delete.push(relative)
      continue
    }
    if (sameEntry(childEntry, baseEntry)) {
      result.keep.push(relative)
      continue
    }
    if (sameEntry(mainEntry, childEntry)) {
      result.keep.push(relative)
      continue
    }

    let mergedContent: string | undefined
    if (baseEntry?.text !== undefined && mainEntry?.text !== undefined && childEntry?.text !== undefined)
      mergedContent = renderMergedText(baseEntry.text, mainEntry.text, childEntry.text)
    if (mergedContent !== undefined) {
      result.apply.push(applyEntryFrom(mainEntry ?? childEntry, "merged", mergedContent)!)
      continue
    }

    const kind = conflictKind(baseEntry, mainEntry, childEntry)
    const summary = conflictSummary(relative, kind, roots, baseEntry, mainEntry, childEntry)
    conflictPaths.add(relative)
    result.conflicts.push(summary)
  }

  for (const [relative, resolution] of resolutions) {
    if (!conflictPaths.has(relative)) fail(`resolution does not name an unresolved conflict: ${relative}`)
    const mainEntry = main.get(relative)
    const childEntry = child.get(relative)
    result.conflicts = result.conflicts.filter((conflict) => conflict.path !== relative)
    if (resolution.use === "main") {
      if (mainEntry) result.keep.push(relative)
      else result.delete.push(relative)
    } else if (childEntry) result.apply.push(applyEntryFrom(childEntry, "child")!)
    else result.delete.push(relative)
  }

  result.apply.sort((left, right) => left.path.localeCompare(right.path))
  result.keep = [...new Set(result.keep)].sort((left, right) => left.localeCompare(right))
  result.delete = [...new Set(result.delete)].sort((left, right) => left.localeCompare(right))
  result.conflicts.sort((left, right) => left.path.localeCompare(right.path))
  return { roots, base, main, child, plan: result }
}

function resolvePreparedPlan(
  prepared: WorkspaceMergePreparation,
  resolutions: readonly MergeResolution[] | undefined,
): MergePlan {
  if (!resolutions?.length) return prepared.plan

  const result: MergePlan = {
    apply: [...prepared.plan.apply],
    keep: [...prepared.plan.keep],
    delete: [...prepared.plan.delete],
    conflicts: [...prepared.plan.conflicts],
  }
  const conflictPaths = new Set(result.conflicts.map((conflict) => conflict.path))
  const seen = new Set<string>()
  for (const resolution of resolutions) {
    const relative = canonicalRelative(resolution.path, "resolution path")
    if (resolution.use !== "main" && resolution.use !== "child") fail(`invalid resolution for ${relative}`)
    if (seen.has(relative)) fail(`duplicate resolution for ${relative}`)
    seen.add(relative)
    if (!conflictPaths.has(relative)) fail(`resolution does not name an unresolved conflict: ${relative}`)

    const mainEntry = prepared.main.get(relative)
    const childEntry = prepared.child.get(relative)
    result.conflicts = result.conflicts.filter((conflict) => conflict.path !== relative)
    if (resolution.use === "main") {
      if (mainEntry) result.keep.push(relative)
      else result.delete.push(relative)
    } else if (childEntry) result.apply.push(applyEntryFrom(childEntry, "child")!)
    else result.delete.push(relative)
  }

  result.apply.sort((left, right) => left.path.localeCompare(right.path))
  result.keep = [...new Set(result.keep)].sort((left, right) => left.localeCompare(right))
  result.delete = [...new Set(result.delete)].sort((left, right) => left.localeCompare(right))
  result.conflicts.sort((left, right) => left.path.localeCompare(right.path))
  return result
}

export function planWorkspaceMerge(input: WorkspaceMergeInput): MergePlan {
  return prepareWorkspaceMerge(input).plan
}

type JournalItem = {
  path: string
  action: "apply" | "delete"
  before: string | null
  after: string | null
  staged_path?: string
  backup_path?: string
}

type MergeJournal = {
  version: 1
  status: "running" | "applied" | "conflict" | "failed" | "stale"
  roots: { base: string; main: string; child: string }
  target_fingerprint: string
  target_entries: Record<string, string>
  items: JournalItem[]
  applied_paths: string[]
  conflicts: MergeConflictSummary[]
  error?: string
}

function fingerprintEntries(entries: Map<string, FileEntry>) {
  return hashText(
    [...entries.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.path}\0${entryFingerprint(entry)}`)
      .join("\n"),
  )
}

function targetEntries(entries: Map<string, FileEntry>) {
  return Object.fromEntries([...entries.entries()].map(([relative, entry]) => [relative, entryFingerprint(entry)!]))
}

function targetPath(root: string, relative: string) {
  const pathname = path.resolve(root, ...relative.split("/"))
  if (!isWithin(root, pathname)) fail(`target path escapes main workspace: ${relative}`)
  return pathname
}

function ensureParentDirectories(root: string, pathname: string) {
  fs.mkdirSync(root, { recursive: true })
  const relative = path.relative(root, path.dirname(pathname))
  const parts = relative ? relative.split(path.sep) : []
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) fail(`target parent is a symlink: ${path.relative(root, current)}`)
    if (stat && !stat.isDirectory()) fail(`target parent is not a directory: ${path.relative(root, current)}`)
    if (!stat) fs.mkdirSync(current)
  }
}

function removeTarget(root: string, relative: string) {
  const pathname = targetPath(root, relative)
  const stat = fs.lstatSync(pathname, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) fail(`refusing to replace a directory: ${relative}`)
  fs.rmSync(pathname, { force: true })
}

function copyToStage(entry: MergeApplyEntry, stageRoot: string) {
  const pathname = targetPath(stageRoot, entry.path)
  ensureParentDirectories(stageRoot, pathname)
  if (entry.kind === "symlink") fs.symlinkSync(entry.link ?? "", pathname)
  else if (entry.content !== undefined) fs.writeFileSync(pathname, entry.content)
  else fs.writeFileSync(pathname, entry.bytes ?? new Uint8Array())
  return pathname
}

function copyExistingToBackup(root: string, relative: string, backupRoot: string) {
  const source = targetPath(root, relative)
  const stat = fs.lstatSync(source, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (stat.isDirectory() && !stat.isSymbolicLink()) fail(`refusing to back up a directory: ${relative}`)
  const backup = targetPath(backupRoot, relative)
  ensureParentDirectories(backupRoot, backup)
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), backup)
  else fs.copyFileSync(source, backup)
  return backup
}

function replaceFromStage(root: string, relative: string, staged: string) {
  const destination = targetPath(root, relative)
  ensureParentDirectories(root, destination)
  removeTarget(root, relative)
  const stat = fs.lstatSync(staged)
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(staged), destination)
  else fs.copyFileSync(staged, destination)
}

function restoreBackup(root: string, relative: string, backup: string | undefined) {
  removeTarget(root, relative)
  if (!backup || (!fs.existsSync(backup) && !fs.lstatSync(backup, { throwIfNoEntry: false }))) return
  const destination = targetPath(root, relative)
  ensureParentDirectories(root, destination)
  const stat = fs.lstatSync(backup)
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(backup), destination)
  else fs.copyFileSync(backup, destination)
}

function writeJournal(pathname: string, value: MergeJournal) {
  const temporary = `${pathname}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(pathname), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(value))
  if (fs.existsSync(pathname)) fs.rmSync(pathname, { force: true })
  fs.renameSync(temporary, pathname)
}

function readJournal(pathname: string): MergeJournal | undefined {
  if (!fs.existsSync(pathname)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as MergeJournal
    if (value.version !== 1 || !value.status || !Array.isArray(value.items)) fail("invalid merge journal")
    return value
  } catch (error) {
    if (error instanceof WorkspaceMergeError) throw error
    fail(`invalid merge journal: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function journalResult(
  journal: MergeJournal,
  status: WorkspaceMergeTransactionResult["status"],
  plan: MergePlan,
  error?: string,
) {
  return {
    status,
    applied_paths: [...journal.applied_paths].sort((left, right) => left.localeCompare(right)),
    conflicts: journal.conflicts,
    plan,
    journal_path: path.join(journal.roots.child, ".merge-journal-unavailable"),
    target_fingerprint: journal.target_fingerprint,
    ...(error ? { error } : {}),
  }
}

function buildPlanFromJournal(journal: MergeJournal): MergePlan {
  return {
    apply: [],
    keep: [],
    delete: journal.items.filter((item) => item.action === "delete").map((item) => item.path),
    conflicts: journal.conflicts,
  }
}

function currentTargetEntries(root: string) {
  return scanWorkspace(root)
}

function expectedTargetFingerprint(journal: MergeJournal) {
  return hashText(
    Object.entries(journal.target_entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relative, fingerprint]) => `${relative}\0${fingerprint}`)
      .join("\n"),
  )
}

function targetMatchesJournal(root: string, journal: MergeJournal) {
  const current = targetEntries(currentTargetEntries(root))
  const expected = { ...journal.target_entries }
  for (const item of journal.items) {
    if (!journal.applied_paths.includes(item.path)) continue
    if (item.after === null) delete expected[item.path]
    else expected[item.path] = item.after
  }
  return JSON.stringify(Object.entries(current).sort()) === JSON.stringify(Object.entries(expected).sort())
}

function applyJournal(
  journal: MergeJournal,
  journalPath: string,
  stageRoot: string,
  backupRoot: string,
  options: WorkspaceMergeTransactionOptions,
) {
  const writes = journal.applied_paths.length
  let completedWrites = writes
  for (const item of journal.items) {
    const current = entryFingerprint(currentTargetEntries(journal.roots.main).get(item.path))
    if (journal.applied_paths.includes(item.path)) continue
    if (current !== item.before) fail(`target changed before applying ${item.path}`)
    item.backup_path = copyExistingToBackup(journal.roots.main, item.path, backupRoot)
    if (item.action === "delete") removeTarget(journal.roots.main, item.path)
    else if (!item.staged_path) fail(`journal item lacks staged path: ${item.path}`)
    else replaceFromStage(journal.roots.main, item.path, item.staged_path)
    journal.applied_paths.push(item.path)
    completedWrites++
    writeJournal(journalPath, journal)
    if (options.interruptAfterWrites !== undefined && completedWrites >= options.interruptAfterWrites)
      throw new Error("simulated interruption")
    if (options.failAfterWrites !== undefined && completedWrites >= options.failAfterWrites)
      throw new Error("simulated write failure")
  }
}

function rollbackJournal(journal: MergeJournal) {
  for (const item of [...journal.items].reverse()) {
    if (!journal.applied_paths.includes(item.path)) continue
    restoreBackup(journal.roots.main, item.path, item.backup_path)
  }
  journal.applied_paths = []
}

export function workspaceFingerprint(root: string) {
  return fingerprintEntries(scanWorkspace(canonicalRoot(root, "workspace")))
}

export function applyWorkspaceMerge(
  input: WorkspaceMergeTransactionInput,
  options: WorkspaceMergeTransactionOptions = {},
  prepared?: WorkspaceMergePreparation,
): WorkspaceMergeTransactionResult {
  const roots = {
    base: canonicalRoot(input.base, "base"),
    main: canonicalRoot(input.main, "main"),
    child: canonicalRoot(input.child, "child"),
  }
  const journalDirectory = path.resolve(input.journal_directory)
  if (!path.isAbsolute(input.journal_directory)) fail("journal_directory must be absolute")
  fs.mkdirSync(journalDirectory, { recursive: true })
  const journalPath = path.join(journalDirectory, "merge.json")
  const stageRoot = path.join(journalDirectory, "stage")
  const backupRoot = path.join(journalDirectory, "backup")
  const existing = readJournal(journalPath)
  if (existing && existing.status === "applied")
    return {
      status: "already_merged",
      applied_paths: [...existing.applied_paths].sort((left, right) => left.localeCompare(right)),
      conflicts: existing.conflicts,
      plan: buildPlanFromJournal(existing),
      journal_path: journalPath,
      target_fingerprint: existing.target_fingerprint,
    }

  if (existing && existing.status === "running") {
    try {
      if (!targetMatchesJournal(roots.main, existing)) {
        existing.status = "stale"
        existing.error = "target changed while recovering merge journal"
        writeJournal(journalPath, existing)
        return {
          status: "stale",
          applied_paths: existing.applied_paths,
          conflicts: existing.conflicts,
          plan: buildPlanFromJournal(existing),
          journal_path: journalPath,
          target_fingerprint: existing.target_fingerprint,
          error: existing.error,
        }
      }
      applyJournal(existing, journalPath, stageRoot, backupRoot, options)
      existing.status = existing.conflicts.length ? "conflict" : "applied"
      writeJournal(journalPath, existing)
      return {
        status: existing.conflicts.length ? "conflict" : "merged",
        applied_paths: [...existing.applied_paths].sort((left, right) => left.localeCompare(right)),
        conflicts: existing.conflicts,
        plan: buildPlanFromJournal(existing),
        journal_path: journalPath,
        target_fingerprint: existing.target_fingerprint,
      }
    } catch (error) {
      if (error instanceof Error && error.message === "simulated interruption") throw error
      try {
        rollbackJournal(existing)
      } finally {
        existing.status = "failed"
        existing.error = error instanceof Error ? error.message : String(error)
        writeJournal(journalPath, existing)
      }
      return {
        status: "failed",
        applied_paths: [],
        conflicts: existing.conflicts,
        plan: buildPlanFromJournal(existing),
        journal_path: journalPath,
        target_fingerprint: existing.target_fingerprint,
        error: existing.error,
      }
    }
  }

  fs.rmSync(stageRoot, { recursive: true, force: true })
  fs.rmSync(backupRoot, { recursive: true, force: true })
  const reusable =
    prepared &&
    prepared.roots.base === roots.base &&
    prepared.roots.main === roots.main &&
    prepared.roots.child === roots.child
      ? { ...prepared, plan: resolvePreparedPlan(prepared, input.resolutions) }
      : prepareWorkspaceMerge(input)
  const mainEntries = reusable.main
  const targetFingerprint = fingerprintEntries(mainEntries)
  const plan = reusable.plan
  const journal: MergeJournal = {
    version: 1,
    status: "running",
    roots,
    target_fingerprint: targetFingerprint,
    target_entries: targetEntries(mainEntries),
    items: [],
    applied_paths: [],
    conflicts: plan.conflicts,
  }
  for (const entry of plan.apply) {
    const staged = copyToStage(entry, stageRoot)
    journal.items.push({
      path: entry.path,
      action: "apply",
      before: entryFingerprint(mainEntries.get(entry.path)),
      after: planEntryFingerprint(entry),
      staged_path: staged,
    })
  }
  for (const relative of plan.delete)
    journal.items.push({
      path: relative,
      action: "delete",
      before: entryFingerprint(mainEntries.get(relative)),
      after: null,
    })
  writeJournal(journalPath, journal)
  if (journal.items.length === 0) {
    journal.status = journal.conflicts.length ? "conflict" : "applied"
    writeJournal(journalPath, journal)
    return {
      status: journal.conflicts.length ? "conflict" : "merged",
      applied_paths: [],
      conflicts: journal.conflicts,
      plan,
      journal_path: journalPath,
      target_fingerprint: targetFingerprint,
    }
  }
  try {
    options.beforeApply?.()
    if (fingerprintEntries(scanWorkspace(roots.main)) !== targetFingerprint) {
      journal.status = "stale"
      journal.error = "target changed after merge preparation"
      writeJournal(journalPath, journal)
      return {
        status: "stale",
        applied_paths: [],
        conflicts: journal.conflicts,
        plan,
        journal_path: journalPath,
        target_fingerprint: targetFingerprint,
        error: journal.error,
      }
    }
    applyJournal(journal, journalPath, stageRoot, backupRoot, options)
    journal.status = journal.conflicts.length ? "conflict" : "applied"
    writeJournal(journalPath, journal)
    return {
      status: journal.conflicts.length ? "conflict" : "merged",
      applied_paths: [...journal.applied_paths].sort((left, right) => left.localeCompare(right)),
      conflicts: journal.conflicts,
      plan,
      journal_path: journalPath,
      target_fingerprint: targetFingerprint,
    }
  } catch (error) {
    if (error instanceof Error && error.message === "simulated interruption") throw error
    try {
      rollbackJournal(journal)
    } finally {
      journal.status = "failed"
      journal.error = error instanceof Error ? error.message : String(error)
      writeJournal(journalPath, journal)
    }
    return {
      status: "failed",
      applied_paths: [],
      conflicts: journal.conflicts,
      plan,
      journal_path: journalPath,
      target_fingerprint: targetFingerprint,
      error: journal.error,
    }
  }
}

export * as WorkspaceMerge from "./workspace-merge"
