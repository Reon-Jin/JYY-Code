import { For, Match, Show, Switch } from 'solid-js'
import type { Message, MessagePart } from '../../types/models'
import { TextBlock } from './blocks/TextBlock'
import { ReasoningBlock } from './blocks/ReasoningBlock'
import { ToolCallBlock } from './blocks/ToolCallBlock'
import { PermissionBlock } from './blocks/PermissionBlock'

interface Props {
  message: Message
  isStreaming?: boolean
  onApprovePermission: (permissionId: string) => void
  onDenyPermission: (permissionId: string) => void
}

export function AssistantMessage(props: Props) {
  return (
    <div class="message-row assistant-row">
      <div class="assistant-meta">
        <span class="assistant-mark">J</span>
        <span>JYYCode</span>
        <Show when={props.isStreaming}>
          <span class="stream-dot" />
        </Show>
      </div>

      <div class="assistant-parts">
        <For each={props.message.parts}>
          {(part) => <PartRenderer part={part} onApprove={props.onApprovePermission} onDeny={props.onDenyPermission} />}
        </For>
      </div>
    </div>
  )
}

function PartRenderer(props: {
  part: MessagePart
  onApprove: (permissionId: string) => void
  onDeny: (permissionId: string) => void
}) {
  return (
    <Switch>
      <Match when={props.part.type === 'text' && props.part}>{(part) => <TextBlock part={part()} />}</Match>
      <Match when={props.part.type === 'reasoning' && props.part}>{(part) => <ReasoningBlock part={part()} />}</Match>
      <Match when={props.part.type === 'tool_call' && props.part}>{(part) => <ToolCallBlock part={part()} />}</Match>
      <Match when={props.part.type === 'permission_request' && props.part}>
        {(part) => (
          <PermissionBlock
            part={part()}
            onApprove={() => {
              const id = part().id
              if (id) props.onApprove(id)
            }}
            onDeny={() => {
              const id = part().id
              if (id) props.onDeny(id)
            }}
          />
        )}
      </Match>
    </Switch>
  )
}
