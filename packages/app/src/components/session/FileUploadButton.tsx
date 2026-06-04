import { Badge } from '../ui/Badge'
import { useSessionStore, sessionActions } from '../../stores/session'

interface Props {
  onSelect: (files: string[]) => void
}

export function FileUploadButton(props: Props) {
  const session = useSessionStore()

  async function handleClick() {
    if (!window.electron?.selectDirectory) {
      // Fallback: use file input
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = (e) => {
        const files = Array.from((e.target as HTMLInputElement).files || [])
          .map(f => (f as any).path || f.name)
        if (files.length > 0) {
          props.onSelect(files)
          files.forEach(f => sessionActions.addContextFile(f))
        }
      }
      input.click()
      return
    }

    // For now, use native file dialog (simple version without directory)
    // In production, would use Electron dialog
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = (e) => {
      const files = Array.from((e.target as HTMLInputElement).files || [])
        .map(f => (f as any).path || f.name)
      if (files.length > 0) {
        props.onSelect(files)
        files.forEach(f => sessionActions.addContextFile(f))
      }
    }
    input.click()
  }

  return (
    <button
      onClick={handleClick}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: 'var(--space-6)',
        padding: '4px 12px',
        'border-radius': 'var(--radius-standard)',
        border: 'none',
        background: 'rgba(255,255,255,0.12)',
        color: 'var(--color-text-white)',
        'font-size': '13px',
        cursor: 'pointer',
        transition: 'background 0.15s',
        position: 'relative',
      }}
      title="上传文件"
    >
      <span style={{ 'font-size': '16px' }}>📎</span>
      <span>文件</span>
      {session.contextFiles.length > 0 && (
        <Badge count={session.contextFiles.length} />
      )}
    </button>
  )
}
