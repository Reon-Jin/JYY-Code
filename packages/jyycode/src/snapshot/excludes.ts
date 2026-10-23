// Dependency installs and disposable runtime state are not delivered changes.
// Keep build/dist outputs and ordinary dotfiles eligible for review.
export const excludedChangeDirectories = [
  ".jyycode",
  ".temp",
  ".tmp",
  ".venv",
  "venv",
  "node_modules",
  "bower_components",
  "site-packages",
  ".pnpm-store",
  ".npm",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
] as const

const directories = new Set<string>(excludedChangeDirectories)

export const changeExclusionPatterns = [...excludedChangeDirectories.map((name) => `${name}/`), "*.pyc", "*.pyo"]

export function isExcludedChange(file: string | undefined) {
  if (!file) return false
  const parts = file.replaceAll("\\", "/").split("/")
  return parts.some((part) => directories.has(part)) || /\.py[co]$/i.test(file)
}
