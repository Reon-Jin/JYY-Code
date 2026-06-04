import { Badge } from '../ui/Badge'
import { useSessionStore } from '../../stores/session'

interface Props {
  onSelect: (files: string[]) => void
}

export function FileUploadButton(props: Props) {
  const session = useSessionStore()

  function handleClick() {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = (event) => {
      const files = Array.from((event.target as HTMLInputElement).files || [])
        .map((file) => (file as File & { path?: string }).path || file.name)

      if (files.length === 0) return
      props.onSelect(files)
    }
    input.click()
  }

  return (
    <button class="toolbar-control upload-control" onClick={handleClick} title="Attach files">
      <span class="control-label">Files</span>
      {session.contextFiles.length > 0 && <Badge count={session.contextFiles.length} />}
    </button>
  )
}
