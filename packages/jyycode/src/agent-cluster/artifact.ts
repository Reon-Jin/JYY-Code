export * as AgentClusterArtifact from "./artifact"

import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect } from "effect"
import path from "path"

export type ArtifactCheck = {
  path: string
  exists: boolean
  kind: "file" | "directory" | "missing"
  size?: number
  sha256?: string
  error?: string
}

export const checkArtifacts = Effect.fn("AgentClusterArtifact.checkArtifacts")(function* (
  artifactPaths: readonly string[],
  options: {
    workspaceDir: string
    artifactDir?: string
    maxHashSize?: number
  },
) {
  const fs = yield* AppFileSystem.Service
  const maxHash = options.maxHashSize ?? 10 * 1024 * 1024 // 10 MB default

  const allowedRoots = [
    options.workspaceDir,
    ...(options.artifactDir ? [options.artifactDir] : []),
  ].map((dir) => path.resolve(dir))

  const results: ArtifactCheck[] = []

  for (const artifactPath of artifactPaths) {
    const resolved = path.isAbsolute(artifactPath)
      ? path.resolve(artifactPath)
      : path.resolve(options.workspaceDir, artifactPath)

    // Path traversal check
    const isAllowed = allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)
    if (!isAllowed) {
      results.push({
        path: artifactPath,
        exists: false,
        kind: "missing",
        error: `Path "${artifactPath}" resolves outside allowed roots`,
      })
      continue
    }

    try {
      const stat = yield* fs.stat(resolved)
      if (stat.isDirectory()) {
        results.push({ path: artifactPath, exists: true, kind: "directory" })
      } else {
        const check: ArtifactCheck = { path: artifactPath, exists: true, kind: "file", size: stat.size }
        if (stat.size <= maxHash) {
          try {
            const content = yield* fs.readFile(resolved)
            const hashBuffer = yield* Effect.sync(() => {
              // Use Bun's built-in crypto hasher
              const hasher = new Bun.CryptoHasher("sha256")
              hasher.update(content)
              return hasher.digest("hex")
            })
            check.sha256 = hashBuffer
          } catch {
            // Hash failure is non-fatal
          }
        }
        results.push(check)
      }
    } catch (err) {
      results.push({
        path: artifactPath,
        exists: false,
        kind: "missing",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
})

export function allRequiredArtifactsPresent(checks: readonly ArtifactCheck[]): boolean {
  return checks.every((c) => c.exists && c.kind !== "missing")
}

export function missingArtifacts(checks: readonly ArtifactCheck[]): ArtifactCheck[] {
  return checks.filter((c) => !c.exists || c.kind === "missing")
}
