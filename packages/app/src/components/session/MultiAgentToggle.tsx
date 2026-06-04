import { Toggle } from '../ui/Toggle'

interface Props {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function MultiAgentToggle(props: Props) {
  return (
    <div class="toolbar-control compact-toggle" title="Enable multi-agent mode">
      <span class="control-label">Agents</span>
      <Toggle checked={props.enabled} onChange={props.onChange} size="sm" />
    </div>
  )
}
