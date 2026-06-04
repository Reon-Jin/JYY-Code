import { ModelSelector } from './ModelSelector'
import { MultiAgentToggle } from './MultiAgentToggle'
import { FileUploadButton } from './FileUploadButton'
import { PermissionsButton } from './PermissionsButton'
import { ThinkingDepthSlider } from './ThinkingDepthSlider'
import type { ModelInfo, PermissionRule } from '../../types/models'

interface ToolbarProps {
  model: string
  models: ModelInfo[]
  onModelChange: (modelId: string) => void
  multiAgent: boolean
  onMultiAgentChange: (enabled: boolean) => void
  onFileSelect: (files: string[]) => void
  permissions: PermissionRule[]
  onPermissionChange: (rules: PermissionRule[]) => void
  thinkingDepth: number
  onThinkingDepthChange: (depth: number) => void
  sessionTitle?: string
  connected?: boolean
}

export function Toolbar(props: ToolbarProps) {
  return (
    <header class="session-toolbar">
      <div class="session-title-group">
        <span class="workspace-dot" data-state={props.connected ? 'on' : 'off'} />
        <span class="session-title-text">{props.sessionTitle || 'New task'}</span>
      </div>

      <div class="toolbar-spacer" />

      <MultiAgentToggle enabled={props.multiAgent} onChange={props.onMultiAgentChange} />
      <FileUploadButton onSelect={props.onFileSelect} />
      <PermissionsButton rules={props.permissions} onChange={props.onPermissionChange} />
      <ThinkingDepthSlider value={props.thinkingDepth} onChange={props.onThinkingDepthChange} />
      <ModelSelector selected={props.model} models={props.models} onChange={props.onModelChange} />
    </header>
  )
}
