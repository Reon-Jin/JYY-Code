import { Show } from 'solid-js'
import type { ToolCallPart } from '../../../types/models'

interface Props {
  part: ToolCallPart
}

const toolLabels: Record<string, string> = {
  read: 'Read file',
  write: 'Write file',
  shell: 'Run command',
  grep: 'Search code',
  glob: 'Find files',
  edit: 'Edit code',
  apply_patch: 'Apply patch',
  web_fetch: 'Fetch URL',
  web_search: 'Search web',
  task: 'Subtask',
  question: 'Question',
  skill: 'Skill',
}

export function ToolCallBlock(props: Props) {
  const { part } = props

  function formatInput(): string {
    const input = part.toolInput || {}
    if (input.filePath) return String(input.filePath)
    if (input.command) return String(input.command)
    if (input.url) return String(input.url)
    if (input.query) return String(input.query)
    if (input.pattern) return String(input.pattern)
    return JSON.stringify(input).slice(0, 160)
  }

  return (
    <section class="tool-call" data-status={part.status}>
      <div class="tool-header">
        <strong>{toolLabels[part.toolName] || part.toolName}</strong>
        <span>{part.status}</span>
        <Show when={part.elapsed !== undefined}>
          <span>{part.elapsed!.toFixed(1)}s</span>
        </Show>
      </div>
      <code>{formatInput()}</code>
      <Show when={part.status === 'completed' && part.toolOutput}>
        <pre>{part.toolOutput}</pre>
      </Show>
    </section>
  )
}
