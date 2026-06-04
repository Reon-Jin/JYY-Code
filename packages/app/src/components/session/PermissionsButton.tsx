import { createSignal, For } from 'solid-js'
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
  { name: 'shell', label: 'Run commands' },
  { name: 'web_fetch', label: 'Network access' },
  { name: 'edit', label: 'Edit code' },
]

export function PermissionsButton(props: Props) {
  const [rules, setRules] = createSignal(props.rules)

  function handleToggle(toolName: string) {
    const current = rules()
    const existing = current.find((rule) => rule.toolName === toolName)
    const nextPolicy = existing?.policy === 'allow' ? 'ask' : 'allow'
    const nextRules = [...current.filter((rule) => rule.toolName !== toolName), { toolName, policy: nextPolicy }]

    setRules(nextRules)
    props.onChange(nextRules)
  }

  function getPolicy(toolName: string): 'allow' | 'deny' | 'ask' {
    return rules().find((rule) => rule.toolName === toolName)?.policy || 'ask'
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
