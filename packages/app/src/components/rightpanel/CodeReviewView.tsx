import { For, Show, createSignal } from 'solid-js'
import type { FileChange } from '../../types/models'
import { FileDiff } from './FileDiff'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

interface Props {
  changes: FileChange[]
}

export function CodeReviewView(props: Props) {
  const [action, setAction] = createSignal<'none' | 'accept' | 'reject'>('none')

  const totalAdditions = () => props.changes.reduce((s, c) => s + c.additions, 0)
  const totalDeletions = () => props.changes.reduce((s, c) => s + c.deletions, 0)

  return (
    <Show when={props.changes.length > 0} fallback={
      <div style={{
        'text-align': 'center',
        padding: '32px 0',
        color: 'var(--color-text-tertiary)',
      }}>
        <p style={{ 'font-size': '28px', 'margin-bottom': '12px' }}>📝</p>
        <p class="text-caption">暂无代码变更</p>
        <p class="text-micro" style={{ 'margin-top': '8px', color: 'var(--color-text-tertiary)' }}>
          当 Agent 修改代码时，变更将在此展示
        </p>
      </div>
    }>
      <div>
        <h4 class="text-caption-bold" style={{ 'margin-bottom': '12px', color: 'var(--color-text-secondary)' }}>
          代码审查 · {props.changes.length} 个文件
        </h4>

        {/* Summary pills */}
        <div style={{
          display: 'flex',
          gap: 'var(--space-8)',
          'margin-bottom': '16px',
          'flex-wrap': 'wrap',
        }}>
          <span style={{
            'font-size': '12px',
            color: '#2cbe4e',
            'font-weight': '600',
            background: 'var(--diff-addition-bg)',
            padding: '2px 8px',
            'border-radius': '980px',
          }}>
            +{totalAdditions()}
          </span>
          <span style={{
            'font-size': '12px',
            color: '#cb2431',
            'font-weight': '600',
            background: 'var(--diff-deletion-bg)',
            padding: '2px 8px',
            'border-radius': '980px',
          }}>
            −{totalDeletions()}
          </span>
        </div>

        {/* File list */}
        <div style={{ 'margin-bottom': '16px' }}>
          <For each={props.changes}>
            {(change) => <FileDiff change={change} />}
          </For>
        </div>

        {/* Action bar */}
        <div style={{
          display: 'flex',
          gap: 'var(--space-8)',
          'padding-top': 'var(--space-10)',
          'border-top': '1px solid rgba(0,0,0,0.06)',
        }}>
          <Button variant="primary" size="sm" onClick={() => setAction('accept')}>
            接受全部
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAction('reject')}>
            拒绝全部
          </Button>
          <Button variant="ghost" size="sm">
            逐条审查
          </Button>
        </div>
      </div>
    </Show>
  )
}
