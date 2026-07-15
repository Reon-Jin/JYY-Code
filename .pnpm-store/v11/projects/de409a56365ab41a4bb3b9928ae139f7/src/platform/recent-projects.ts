import type { RecentProject } from "./types"

const MAX_RECENT_PROJECTS = 10

function comparisonPath(path: string) {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase("en-US")
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    typeof candidate.usedAt === "number" &&
    Number.isFinite(candidate.usedAt)
  )
}

export function normalizeRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  return value
    .filter(isRecentProject)
    .sort((left, right) => right.usedAt - left.usedAt)
    .filter((project) => {
      const key = comparisonPath(project.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_RECENT_PROJECTS)
}

export function touchRecentProject(projects: readonly RecentProject[], path: string, usedAt = Date.now()) {
  return normalizeRecentProjects([{ path, usedAt }, ...projects])
}
