// Match the backend snapshot exclusions, including historical saved summaries.
// Build/dist outputs and ordinary dotfiles remain visible deliverables.
const directories = new Set([
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
])

export function isExcludedChange(file: string | undefined) {
  if (!file) return false
  const parts = file.replaceAll("\\", "/").split("/")
  return parts.some((part) => directories.has(part)) || /\.py[co]$/i.test(file)
}
