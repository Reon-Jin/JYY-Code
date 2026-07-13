import type { Agent } from "@jyycode-ai/sdk/v2/client"
import { For } from "solid-js"

export function AgentSelect(props: {
  agents: readonly Agent[]
  value: string
  disabled?: boolean
  onChange: (name: string) => void
}) {
  return (
    <label class="composer-select">
      <span>Agent</span>
      <select
        aria-label="Agent"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <For each={props.agents}>
          {(agent) => <option value={agent.name}>{agent.name}</option>}
        </For>
      </select>
    </label>
  )
}
