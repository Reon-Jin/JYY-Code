import { parsePatch } from "diff"

export type UnifiedDiffLine = {
  kind: "context" | "add" | "delete"
  oldNumber?: number
  newNumber?: number
  content: string
}

export type UnifiedDiffHunk = {
  header: string
  lines: UnifiedDiffLine[]
}

export type UnifiedDiff = { hunks: UnifiedDiffHunk[] }

export function firstChangedLine(diff: UnifiedDiff) {
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" || line.kind === "delete") return line.newNumber ?? line.oldNumber
    }
  }
  return undefined
}

export function oldContentFromUnifiedDiff(patch: string | undefined) {
  const diff = parseUnifiedDiff(patch)
  if (diff.hunks.length === 0) return undefined
  const lines = diff.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line.kind === "add" ? [] : [line.content])))
  return lines.join("\n")
}

function hunkHeader(oldStart: number, oldLines: number, newStart: number, newLines: number) {
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
}

export function parseUnifiedDiff(patch: string | undefined): UnifiedDiff {
  if (!patch?.trim() || /^(?:Binary files|GIT binary patch)/m.test(patch)) return { hunks: [] }

  try {
    const parsed = parsePatch(patch)
    const hunks = parsed.flatMap((file) =>
      file.hunks.map((hunk) => {
        let oldNumber = hunk.oldStart
        let newNumber = hunk.newStart
        const lines = hunk.lines.flatMap<UnifiedDiffLine>((line) => {
          const prefix = line[0]
          if (prefix === "\\") return []
          const content = line.slice(1)
          if (prefix === "+") return [{ kind: "add", newNumber: newNumber++, content }]
          if (prefix === "-") return [{ kind: "delete", oldNumber: oldNumber++, content }]
          const result = { kind: "context" as const, oldNumber, newNumber, content }
          oldNumber += 1
          newNumber += 1
          return [result]
        })
        return {
          header: hunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines),
          lines,
        }
      }),
    )
    return { hunks }
  } catch {
    return { hunks: [] }
  }
}
