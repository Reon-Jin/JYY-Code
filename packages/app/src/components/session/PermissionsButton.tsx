import { createSignal } from 'solid-js'
import { Popover } from '../ui/Popover'
import { Toggle } from '../ui/Toggle'
import type { PermissionRule } from '../../types/models'

interface Props {
  rules: PermissionRule[]
  onChange: (rules: PermissionRule[]) => void
}

const allTools = [
  { name: 'read', label: '读取文件' },
  { name: 'write', label: '写入文件' },
  { name: 'shell', label: '执行命令' },
  { name: 'web_fetch', label: '网络请求' },
  { name: 'edit', label: '编辑代码' },
]

export function PermissionsButton(props: Props) {
  const [rules, setRules] = createSignal(props.rules)

  function handleToggle(toolName: string) {
    const current = rules()
    const existing = current.find(r => r.toolName === toolName)
    let newRules: PermissionRule[]

    if (!existing || existing.policy === 'ask') {
      newRules = [...current.filter(r => r.toolName !== toolName), { toolName, policy: 'allow' }]
    } else if (existing.policy === 'allow') {
      newRules = [...current.filter(r => r.toolName !== toolName), { toolName, policy: 'deny' }]
    } else {
      newRules = current.filter(r => r.toolName !== toolName)
    }

    setRules(newRules)
    props.onChange(newRules)
  }

  function getPolicy(toolName: string): 'allow' | 'deny' | 'ask' {
    return rules().find(r => r.toolName === toolName)?.policy || 'ask'
  }

  return (
    <Popover
      trigger={
        <button style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-6)',
          padding: '4px 12px',
          'border-radius': 'var(--radius-standard)',
          border: 'none',
          background: 'rgba(255,255,255,0.12)',
          color: 'var(--color-text-white)',
          'font-size': '13px',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }} title="权限设置">
          <span style={{ 'font-size': '16px' }}>🔒</span>
          <span>权限</span>
        </button>
      }
      width={260}
    >
      <div>
        <h4 class="text-caption-bold" style={{ 'margin-bottom': '12px' }}>
          工具权限
        </h4>
        {allTools.map(tool => (
          <div style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            padding: 'var(--space-8) 0',
            'border-bottom': '1px solid rgba(0,0,0,0.04)',
          }}>
            <span class="text-caption">{tool.label}</span>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span class="text-micro" style={{
                color: getPolicy(tool.name) === 'allow' ? '#34c759' :
                       getPolicy(tool.name) === 'deny' ? '#ff3b30' :
                       'var(--color-text-tertiary)'
              }}>
                {getPolicy(tool.name) === 'allow' ? '允许' :
                 getPolicy(tool.name) === 'deny' ? '拒绝' : '询问'}
              </span>
              <Toggle
                checked={getPolicy(tool.name) === 'allow'}
                onChange={() => handleToggle(tool.name)}
                size="sm"
              />
            </div>
          </div>
        ))}
      </div>
    </Popover>
  )
}
