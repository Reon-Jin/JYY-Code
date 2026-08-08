import fs from "node:fs"
import path from "node:path"

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathGuardError"
  }
}

function exists(pathname: string) {
  try {
    fs.lstatSync(pathname)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/** Resolve a path while canonicalizing every existing ancestor. */
function canonicalPath(pathname: string) {
  let current = path.resolve(pathname)
  const suffix: string[] = []
  while (!exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  try {
    return path.normalize(path.join(fs.realpathSync.native(current), ...suffix))
  } catch {
    return path.normalize(path.join(current, ...suffix))
  }
}

export function canonicalExisting(pathname: string) {
  const absolute = path.resolve(pathname)
  if (!exists(absolute)) throw new PathGuardError(`路径不存在：${pathname}`)
  try {
    return path.resolve(fs.realpathSync.native(absolute))
  } catch (error) {
    throw new PathGuardError(`无法解析路径：${pathname}: ${String(error)}`)
  }
}

function comparisonPath(pathname: string) {
  const normalized = path.normalize(pathname)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isInside(root: string, target: string) {
  const relative = path.relative(comparisonPath(root), comparisonPath(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function assertInside(root: string, target: string, field: string) {
  const canonicalRoot = canonicalPath(root)
  const canonicalTarget = canonicalPath(target)
  if (!isInside(canonicalRoot, canonicalTarget))
    throw new PathGuardError(`${field} 必须位于边界内：${target}`)
}

export function resolveInside(root: string, value: string, field: string) {
  const canonicalRoot = canonicalExisting(root)
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(canonicalRoot, value)
  const canonicalTarget = canonicalPath(absolute)
  if (!isInside(canonicalRoot, canonicalTarget))
    throw new PathGuardError(`${field} 必须位于工作区内：${value}`)
  return canonicalTarget
}

export function assertOutputArtifact(input: { workspaceRoot: string; outputRoot: string; artifact: string }) {
  const outputRoot = resolveInside(input.workspaceRoot, input.outputRoot, "output_path")
  const artifact = resolveInside(input.workspaceRoot, input.artifact, "artifact")
  assertInside(outputRoot, artifact, "artifact")
  if (fs.existsSync(artifact) && !fs.statSync(artifact).isFile())
    throw new PathGuardError(`artifact 必须是普通文件：${input.artifact}`)
  return artifact
}
