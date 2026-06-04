import { createSignal, For, Show } from 'solid-js'
import type { DiffLine, FileChange } from '../../types/models'

interface Props {
  change: FileChange
  defaultExpanded?: boolean
}

export function FileDiff(props: Props) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)

  const statusSign = () => {
    if (props.change.status === 'added') return '+'
    if (props.change.status === 'deleted') return '-'
    return '~'
  }

  return (
    <article class="file-diff">
      <button onClick={() => setExpanded(!expanded())} class="file-diff-header">
        <span class="file-status" data-status={props.change.status}>
          {statusSign()}
        </span>
        <span class="file-path">{props.change.filePath}</span>
        <span class="file-counts">
          <Show when={props.change.additions > 0}>+{props.change.additions}</Show>
          <Show when={props.change.deletions > 0}> -{props.change.deletions}</Show>
        </span>
        <span>{expanded() ? '^' : 'v'}</span>
      </button>

      <Show when={expanded()}>
        <div class="diff-body">
          <For each={props.change.hunks}>
            {(hunk) => (
              <div>
                <div class="hunk-header">{hunk.header}</div>
                <For each={hunk.lines}>{(line) => <DiffLineRow line={line} />}</For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </article>
  )
}

function DiffLineRow(props: { line: DiffLine }) {
  const sign = () => {
    if (props.line.type === 'addition') return '+'
    if (props.line.type === 'deletion') return '-'
    return ' '
  }

  return (
    <div class="diff-line" data-type={props.line.type}>
      <span class="line-number">{props.line.oldLineNumber ?? ''}</span>
      <span class="line-number">{props.line.newLineNumber ?? ''}</span>
      <span class="line-sign">{sign()}</span>
      <span class="line-content">{props.line.content}</span>
    </div>
  )
}
