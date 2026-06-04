import { Show, Switch, Match } from 'solid-js'
import type { ToolCallPart } from '../../../types/models'

interface Props {
  part: ToolCallPart
}

const toolIcons: Record<string, string> = {
  read: '📄',
  write: '✏️',
  shell: '💻',
  grep: '🔍',
  glob: '📂',
  edit: '🛠️',
  apply_patch: '📝',
  web_fetch: '🌐',
  web_search: '🔎',
  task: '🤖',
  question: '❓',
  skill: '⚡',
}

const toolLabels: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  shell: '执行命令',
  grep: '搜索代码',
  glob: '查找文件',
  edit: '编辑代码',
  apply_patch: '应用补丁',
  web_fetch: '获取网页',
  web_search: '网络搜索',
  task: '子任务',
  question: '询问',
  skill: '技能',
}

export function ToolCallBlock(props: Props) {
  const { part } = props

  const statusColor = () => {
    switch (part.status) {
      case 'completed': return '#34c759'
      case 'running': return 'var(--color-blue-apple)'
      case 'error': return '#ff3b30'
      default: return 'var(--color-text-tertiary)'
    }
  }

  const statusIcon = () => {
    switch (part.status) {
      case 'completed': return '✓'
      case 'running': return '⋯'
      case 'error': return '✗'
      default: return '○'
    }
  }

  // Format tool input for display
  function formatInput(): string {
    const input = part.toolInput
    // Show file paths or command strings prominently
    if (input.filePath) return String(input.filePath)
    if (input.command) return String(input.command)
    if (input.url) return String(input.url)
    if (input.query) return String(input.query)
    if (input.pattern) return String(input.pattern)
    return JSON.stringify(input).slice(0, 120)
  }

  return (
    <div style={{
      margin: 'var(--space-8) 0',
      'border-radius': 'var(--radius-standard)',
      'border-left': `3px solid ${statusColor()}`,
      background: 'var(--color-dark-surface-1)',
      padding: 'var(--space-8) var(--space-10)',
      transition: 'border-color 0.3s',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        'align-items': 'center',
        gap: 'var(--space-8)',
        'margin-bottom': 'var(--space-6)',
      }}>
        <span style={{ 'font-size': '16px' }}>
          {toolIcons[part.toolName] || '🔧'}
        </span>
        <span class="text-caption" style={{
          color: 'var(--color-text-white-secondary)',
          'font-weight': '500',
        }}>
          {toolLabels[part.toolName] || part.toolName}
        </span>
        <span class="text-micro" style={{
          color: statusColor(),
          'margin-left': 'auto',
        }}>
          {statusIcon()} {part.status}
        </span>
        {part.elapsed !== undefined && (
          <span class="text-micro" style={{ color: 'var(--color-text-tertiary)' }}>
            {part.elapsed.toFixed(1)}s
          </span>
        )}
      </div>

      {/* Input preview */}
      <div style={{
        'font-family': 'var(--font-mono)',
        'font-size': '12px',
        color: 'rgba(255,255,255,0.6)',
        padding: 'var(--space-4) var(--space-8)',
        background: 'rgba(0,0,0,0.2)',
        'border-radius': '4px',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
      }}>
        {formatInput()}
      </div>

      {/* Output (if completed and has output) */}
      <Show when={part.status === 'completed' && part.toolOutput}>
        <div style={{
          'margin-top': 'var(--space-8)',
          'font-family': 'var(--font-mono)',
          'font-size': '12px',
          color: 'rgba(255,255,255,0.8)',
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
          'max-height': '200px',
          'overflow-y': 'auto',
          padding: 'var(--space-8)',
          background: 'rgba(0,0,0,0.15)',
          'border-radius': '4px',
        }}>
          {part.toolOutput}
        </div>
      </Show>

      {/* Running animation */}
      <Show when={part.status === 'running'}>
        <div style={{
          height: '2px',
          'margin-top': 'var(--space-6)',
          background: 'linear-gradient(90deg, var(--color-blue-apple) 30%, transparent 70%)',
          'border-radius': '1px',
          animation: 'shimmer 1.5s infinite',
        }} />
        <style>{`@keyframes shimmer { 0%{opacity:0.4} 50%{opacity:1} 100%{opacity:0.4} }`}</style>
      </Show>
    </div>
  )
}
