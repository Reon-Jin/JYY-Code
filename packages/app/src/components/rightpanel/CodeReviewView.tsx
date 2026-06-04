import { For, Show } from 'solid-js'
import type { FileChange } from '../../types/models'
import { FileDiff } from './FileDiff'

interface Props {
  changes: FileChange[]
}

export function CodeReviewView(props: Props) {
  const totalAdditions = () => props.changes.reduce((sum, change) => sum + change.additions, 0)
  const totalDeletions = () => props.changes.reduce((sum, change) => sum + change.deletions, 0)

  return (
    <Show
      when={props.changes.length > 0}
      fallback={
        <div class="panel-empty">
          <h3>File Changes</h3>
          <p>Modified files and diffs will appear here as tools run.</p>
        </div>
      }
    >
      <section class="panel-section">
        <div class="panel-heading">
          <h3>File Changes</h3>
          <span>{props.changes.length} files</span>
        </div>

        <div class="diff-summary">
          <span class="additions">+{totalAdditions()}</span>
          <span class="deletions">-{totalDeletions()}</span>
        </div>

        <div class="file-change-list">
          <For each={props.changes}>{(change) => <FileDiff change={change} />}</For>
        </div>
      </section>
    </Show>
  )
}
