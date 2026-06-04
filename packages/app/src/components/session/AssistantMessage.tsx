import { For, Show, Switch, Match } from 'solid-js'
import type { Message, MessagePart } from '../../types/models'
import { TextBlock } from './blocks/TextBlock'
import { ReasoningBlock } from './blocks/ReasoningBlock'
import { ToolCallBlock } from './blocks/ToolCallBlock'
import { PermissionBlock } from './blocks/PermissionBlock'

interface Props {
  message: Message
  isStreaming?: boolean
  onApprovePermission: () => void
  onDenyPermission: () => void
}

export function AssistantMessage(props: Props) {
  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: 'var(--space-6)',
      position: 'relative',
    }}>
      {/* Avatar/indicator */}
      <div style={{
        display: 'flex',
        'align-items': 'center',
        gap: 'var(--space-8)',
        'margin-bottom': 'var(--space-4)',
      }}>
        <div style={{
          width: '28px',
          height: '28px',
          'border-radius': '50%',
          background: 'linear-gradient(135deg, #0071e3, #2997ff)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'font-size': '14px',
          color: 'white',
        }}>
          🧠
        </div>
        <span class="text-caption-bold" style={{ color: 'var(--color-text-tertiary)' }}>
          JYYCode
        </span>
        {props.isStreaming && (
          <span style={{
            width: '6px', height: '6px', 'border-radius': '50%',
            background: 'var(--color-blue-apple)',
            animation: 'pulse 1s infinite',
          }} />
        )}
      </div>

      {/* Message parts */}
      <div style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--space-4)',
      }}>
        <For each={props.message.parts}>
          {(part) => <PartRenderer part={part} onApprove={props.onApprovePermission} onDeny={props.onDenyPermission} />}
        </For>
      </div>
    </div>
  )
}

// Part dispatcher
function PartRenderer(props: {
  part: MessagePart
  onApprove: () => void
  onDeny: () => void
}) {
  return (
    <Switch>
      <Match when={props.part.type === 'text' && props.part}>
        {(p) => <TextBlock part={p()} />}
      </Match>
      <Match when={props.part.type === 'reasoning' && props.part}>
        {(p) => <ReasoningBlock part={p()} />}
      </Match>
      <Match when={props.part.type === 'tool_call' && props.part}>
        {(p) => <ToolCallBlock part={p()} />}
      </Match>
      <Match when={props.part.type === 'permission_request' && props.part}>
        {(p) => (
          <PermissionBlock
            part={p()}
            onApprove={props.onApprove}
            onDeny={props.onDeny}
          />
        )}
      </Match>
    </Switch>
  )
}
