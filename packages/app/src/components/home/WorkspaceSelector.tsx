import { createSignal } from 'solid-js'
import { Button } from '../ui/Button'

interface Props {
  onSelect: (dir: string) => void
  loading?: boolean
}

export function WorkspaceSelector(props: Props) {
  const [dir, setDir] = createSignal<string | null>(null)

  async function handleBrowse() {
    if (!window.electron?.selectDirectory) return
    const selected = await window.electron.selectDirectory()
    if (selected) {
      setDir(selected)
      props.onSelect(selected)
    }
  }

  return (
    <div style={{
      'text-align': 'center',
    }}>
      <div style={{
        background: 'var(--color-white)',
        'border-radius': 'var(--radius-standard)',
        padding: '24px',
        display: 'inline-flex',
        'flex-direction': 'column',
        'align-items': 'center',
        gap: 'var(--space-14)',
        'box-shadow': 'var(--shadow-card)',
        'max-width': '400px',
        width: '100%',
      }}>
        <div style={{
          'font-size': '32px',
        }}>📁</div>
        <p class="text-body" style={{ color: 'var(--color-text-primary)' }}>
          {dir() ? dir() : '选择一个工作空间目录'}
        </p>
        <Button
          variant="primary"
          pill
          size="lg"
          loading={props.loading}
          onClick={handleBrowse}
        >
          {props.loading ? '启动中...' : '选择目录'}
        </Button>
      </div>
    </div>
  )
}
