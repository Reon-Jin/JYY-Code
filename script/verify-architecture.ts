import { readdir, readFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type ArchitectureViolation = {
  source: string
  target: string
  rule: string
  message: string
  remediation: string
}

export type VerifyArchitectureOptions = {
  rootDir?: string
  files?: readonly string[]
  allowlist?: Readonly<Record<string, string>>
}

/**
 * These are deliberately file-level exceptions. Each entry is temporary and
 * names the migration that owns its removal; directory-wide exemptions are
 * not supported.
 */
export const DEFAULT_ALLOWLIST: Readonly<Record<string, string>> = {
  "packages/core/src/cross-spawn-spawner.ts": "platform adapter; permanent boundary",
  "packages/core/src/process-supervisor.ts": "platform adapter; permanent boundary",
  "packages/jyycode/src/pty/pty.bun.ts": "PTY platform adapter; permanent boundary",
  "packages/jyycode/src/pty/pty.node.ts": "PTY platform adapter; permanent boundary",
  "packages/jyycode/src/cli/cmd/db.ts": "Task 10: migrate CLI database commands to AppProcess",
  "packages/jyycode/src/cli/cmd/github.ts": "Task 10: migrate CLI GitHub commands to AppProcess",
  "packages/jyycode/src/lsp/launch.ts": "Task 10: route LSP launch through AppProcess",
  "packages/jyycode/src/lsp/server.ts": "Task 10: route LSP installation through AppProcess",
  "packages/jyycode/src/plan/child-workspace.ts": "Task 10: migrate workspace subprocesses to AppProcess",
  "packages/jyycode/src/plan/workspace-merge.ts": "Task 10: migrate workspace subprocesses to AppProcess",
  "packages/jyycode/src/shell/shell.ts": "Task 10: migrate shell subprocesses to AppProcess",
  "packages/jyycode/src/util/process.ts": "Task 10: migrate process utility to AppProcess",
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^;\n]*?\sfrom\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^;\n]*?\sfrom\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function normalizeRelativePath(rootDir: string, path: string) {
  return relative(rootDir, path).split(sep).join("/")
}

async function sourceFiles(rootDir: string, directory = rootDir): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".turbo") continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(rootDir, path)))
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path)
    }
  }
  return files
}

function importSpecifiers(contents: string) {
  const result = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) result.add(specifier)
    }
  }
  return [...result]
}

function packageTarget(rootDir: string, specifier: string, sourceFile: string) {
  if (specifier.startsWith(".")) {
    const candidate = resolve(dirname(sourceFile), specifier)
    return normalizeRelativePath(rootDir, candidate)
  }

  const match = specifier.match(/^@jyycode-ai\/([^/]+)/)
  if (match) return `packages/${match[1]}/${specifier.slice(match[0].length).replace(/^\//, "")}`.replace(/\/$/, "")
  if (specifier === "jyycode" || specifier.startsWith("jyycode/"))
    return `packages/jyycode/${specifier.slice("jyycode".length).replace(/^\//, "")}`
  return specifier
}

function packageName(path: string) {
  const match = path.match(/^packages\/([^/]+)/)
  return match?.[1]
}

function isUnder(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function violation(
  source: string,
  target: string,
  rule: string,
  message: string,
  remediation: string,
): ArchitectureViolation {
  return { source, target, rule, message, remediation }
}

export async function verifyArchitecture(options: VerifyArchitectureOptions = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST
  const paths = options.files
    ? options.files.map((path) => (isAbsolute(path) ? path : resolve(rootDir, path)))
    : await sourceFiles(rootDir)
  const violations: ArchitectureViolation[] = []

  for (const file of paths) {
    const source = normalizeRelativePath(rootDir, file)
    const sourcePackage = packageName(source)
    if (!sourcePackage || !isUnder(source, `packages/${sourcePackage}/src`)) continue
    const contents = await readFile(file, "utf8")

    for (const specifier of importSpecifiers(contents)) {
      const target = packageTarget(rootDir, specifier, file)

      if (sourcePackage === "core" && isUnder(target, "packages/jyycode")) {
        violations.push(
          violation(
            source,
            target,
            "core-cannot-import-product",
            "The reusable core package must not depend on the product package.",
            "Move the product orchestration behind a port or invert the dependency.",
          ),
        )
      }

      if (sourcePackage === "llm" && isUnder(target, "packages/jyycode/src/session")) {
        violations.push(
          violation(
            source,
            target,
            "llm-cannot-import-session",
            "The provider/protocol package must remain independent of the product session runtime.",
            "Expose protocol data through the LLM port and keep session orchestration in packages/jyycode.",
          ),
        )
      }

      if (sourcePackage === "core" && (specifier === "@jyycode-ai/plugin" || isUnder(target, "packages/plugin"))) {
        violations.push(
          violation(
            source,
            target,
            "core-cannot-depend-on-plugin",
            "Privileged core services cannot obtain their implementation from the plugin package.",
            "Keep the implementation in the kernel and expose only controlled provider/tool ports.",
          ),
        )
      }

      if (
        (sourcePackage === "core" || sourcePackage === "jyycode") &&
        (specifier === "child_process" || specifier === "node:child_process")
      ) {
        const rationale = allowlist[source]
        if (!rationale) {
          violations.push(
            violation(
              source,
              specifier,
              "business-cannot-import-child-process",
              "Business modules must not import the native child-process API directly.",
              "Use AppProcess.Service or add a narrowly scoped platform adapter with a Task/owner removal rationale.",
            ),
          )
        }
      }
    }
  }

  return violations.sort((a, b) => `${a.source}:${a.rule}`.localeCompare(`${b.source}:${b.rule}`))
}

if (import.meta.main) {
  const violations = await verifyArchitecture()
  if (violations.length === 0) {
    console.log("Architecture verification passed.")
  } else {
    for (const item of violations) {
      console.error(`- ${item.source} -> ${item.target}`)
      console.error(`  rule: ${item.rule}`)
      console.error(`  ${item.message}`)
      console.error(`  fix: ${item.remediation}`)
    }
    process.exitCode = 1
  }
}
