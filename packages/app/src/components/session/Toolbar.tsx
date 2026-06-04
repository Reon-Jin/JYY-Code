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
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div style={{
      display: 'flex',
      'align-items': 'center',
      gap: 'var(--space-8)',
      padding: '0 var(--space-14)',
      height: '48px',
      'min-height': '48px',
      background: 'var(--nav-bg)',
      'backdrop-filter': 'var(--nav-blur)',
      '-webkit-backdrop-filter': 'var(--nav-blur)',
      'border-bottom': '1px solid rgba(0,0,0,0.06)',
      'z-index': '50',
      'flex-shrink': '0',
    }}>
      {/* Session title */}
      {props.sessionTitle && (
        <span class="text-caption-bold" style={{
          color: 'var(--color-text-white)',
          'margin-right': 'var(--space-10)',
          'max-width': '200px',
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
        }}>
          {props.sessionTitle}
        </span>
      )}

      {/* Model selector */}
      <ModelSelector
        selected={props.model}
        models={props.models}
        onChange={props.onModelChange}
      />

      <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.2)' }} />

      {/* Multi-agent toggle */}
      <MultiAgentToggle
        enabled={props.multiAgent}
        onChange={props.onMultiAgentChange}
      />

      {/* File upload */}
      <FileUploadButton onSelect={props.onFileSelect} />

      {/* Permissions */}
      <PermissionsButton
        rules={props.permissions}
        onChange={props.onPermissionChange}
      />

      <div style={{ flex: '1' }} />

      {/* Thinking depth */}
      <ThinkingDepthSlider
        value={props.thinkingDepth}
        onChange={props.onThinkingDepthChange}
      />
    </div>
  )
}
