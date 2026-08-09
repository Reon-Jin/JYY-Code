import path from "node:path"
import { Global } from "@jyycode-ai/core/global"

const runtimeRoots = [Global.Path.data, Global.Path.cache, Global.Path.config, Global.Path.state]

function canonical(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function isRuntimePath(candidate: string) {
  const resolved = canonical(candidate)
  if (runtimeRoots.some((root) => isWithin(canonical(root), resolved))) return true
  const parts = resolved.split(/[\\/]+/)
  return parts.includes(".jyycode")
}

/** Ripgrep globs are relative to cwd; keep the global roots out when nested under it. */
export function runtimeExclusionGlobs(cwd: string) {
  const result = ["!.jyycode/**"]
  const base = canonical(cwd)
  for (const root of runtimeRoots) {
    const relative = path.relative(base, canonical(root)).replaceAll(path.sep, "/")
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue
    result.push(`!${relative}/**`)
  }
  return result
}

export function shouldExcludeRuntimePath(cwd: string, file: string) {
  return isRuntimePath(path.isAbsolute(file) ? file : path.join(cwd, file))
}

export * as RuntimeExcludes from "./runtime-excludes"
