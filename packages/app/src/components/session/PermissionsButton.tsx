import { createEffect, createSignal, For } from 'solid-js'
import { Popover } from '../ui/Popover'
import { Toggle } from '../ui/Toggle'
import type { PermissionRule } from '../../types/models'

interface Props {
  rules: PermissionRule[]
  onChange: (rules: PermissionRule[]) => void
}

const allTools = [
  { name: 'read', label: 'Read files' },
  { name: 'write', label: 'Write files' },
  { name: 'bash', label: 'Run commands' },
  { name: 'webfetch', label: 'Fetch URLs' },
  { name: 'websearch', label: 'Search web' },
  { name: 'edit', label: 'Edit code' },
  { name: 'task', label: 'Subagents' },
]

export function PermissionsButton(props: Props) {
  const [rules, setRules] = createSignal(props.rules)

  createEffect(() => {
    setRules(props.rules)
  })

  function handleToggle(toolName: string) {
    const current = rules()
    const existing = current.find((rule) => rule.permission === toolName && rule.pattern === '*')
    const nextAction = existing?.action === 'allow' ? 'ask' : 'allow'
    const nextRule: PermissionRule = { permission: toolName, pattern: '*', action: nextAction }
    const nextRules = [
      ...current.filter((rule) => !(rule.permission === toolName && rule.pattern === '*')),
      ...(nextAction === 'ask' ? [] : [nextRule]),
    ]

    setRules(nextRules)
    props.onChange(nextRules)
  }

  function getPolicy(toolName: string): 'allow' | 'deny' | 'ask' {
    return rules().find((rule) => rule.permission === toolName && rule.pattern === '*')?.action || 'ask'
  }

  return (
    <Popover
      trigger={
        <button class="toolbar-control" title="Tool permissions">
          <span class="control-label">Permissions</span>
        </button>
      }
      width={280}
    >
      <div class="permission-popover">
        <h4>Tool Permissions</h4>
        <p>Rules apply to the current session.</p>
        <For each={allTools}>
          {(tool) => (
            <div class="permission-row">
              <div>
                <strong>{tool.label}</strong>
                <span>{getPolicy(tool.name)}</span>
              </div>
              <Toggle checked={getPolicy(tool.name) === 'allow'} onChange={() => handleToggle(tool.name)} size="sm" />
            </div>
          )}
        </For>
      </div>
    </Popover>
  )
}
