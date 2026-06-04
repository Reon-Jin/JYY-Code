import type { FileChange, DiffHunk, DiffLine } from '../types/models'

/**
 * Parse unified diff text into FileChange objects.
 * Input format: standard git unified diff.
 */
export function parseDiff(diffText: string): FileChange[] {
  const changes: FileChange[] = []
  const hunkPattern = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)$/

  let currentChange: FileChange | null = null
  let currentHunk: DiffHunk | null = null
  const lines = diffText.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect new file
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (fileMatch) {
      if (currentChange) {
        if (currentHunk) currentChange.hunks.push(currentHunk)
        changes.push(currentChange)
      }

      const filePath = fileMatch[2]
      // Determine status from subsequent lines
      let status: FileChange['status'] = 'modified'
      const nextLines = lines.slice(i, i + 5).join('\n')
      if (nextLines.includes('new file mode')) status = 'added'
      else if (nextLines.includes('deleted file mode')) status = 'deleted'

      currentChange = {
        filePath,
        status,
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      currentHunk = null
      continue
    }

    // Hunk header
    const hunkMatch = line.match(hunkPattern)
    if (hunkMatch && currentChange) {
      if (currentHunk) currentChange.hunks.push(currentHunk)
      currentHunk = {
        header: line,
        lines: [],
      }
      continue
    }

    // Diff lines
    if (currentChange && currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'addition', content: line.slice(1) })
        currentChange.additions++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'deletion', content: line.slice(1) })
        currentChange.deletions++
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line })
      }
    }
  }

  // Push last change
  if (currentChange) {
    if (currentHunk) currentChange.hunks.push(currentHunk)
    changes.push(currentChange)
  }

  return changes
}

/**
 * Get a summary string for a FileChange.
 */
export function diffSummary(change: FileChange): string {
  return `${change.filePath} +${change.additions} -${change.deletions}`
}
