import { createSignal, Show } from 'solid-js'
import type { ReasoningPart } from '../../../types/models'

interface Props {
  part: ReasoningPart
}

export function ReasoningBlock(props: Props) {
  const [collapsed, setCollapsed] = createSignal(props.part.collapsed ?? false)

  return (
    <section class="reasoning-block">
      <button onClick={() => setCollapsed(!collapsed())}>
        <span>Thinking</span>
        <span>{collapsed() ? 'v' : '^'}</span>
      </button>
      <Show when={!collapsed()}>
        <pre>{props.part.content}</pre>
      </Show>
    </section>
  )
}
