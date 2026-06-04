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
    if (!selected) return

    setDir(selected)
    props.onSelect(selected)
  }

  return (
    <section class="workspace-card">
      <div>
        <span class="eyebrow">Workspace</span>
        <h2>{dir() ? dir() : 'Choose a project folder'}</h2>
        <p>JYYCode will use this folder for sessions, file context, tool calls, and diffs.</p>
      </div>
      <Button variant="primary" size="lg" loading={props.loading} onClick={handleBrowse}>
        {props.loading ? 'Starting...' : 'Open Folder'}
      </Button>
    </section>
  )
}
