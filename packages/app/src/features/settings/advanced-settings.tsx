import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { ComingSoonSetting } from "./coming-soon-setting"
import { GlobalConfigReveal } from "./global-config-reveal"

const knownShells = ["pwsh", "powershell", "cmd", "bash"] as const

export function AdvancedSettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const [shell, setShell] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const config = createQuery(
    () => ({
      queryKey: keys.globalConfig,
      queryFn: async () => {
        const response = await management.client.global.config.get({ throwOnError: true })
        if (!response.data) throw new Error("后端未返回全局配置")
        return response.data
      },
    }),
    () => management.queryClient,
  )

  createEffect(() => {
    if (config.data && !saving()) setShell(config.data.shell ?? "")
  })

  async function save(next: string) {
    const previous = shell()
    setShell(next)
    setSaving(true)
    setFailure(undefined)
    try {
      await management.client.global.config.update({ config: { shell: next } }, { throwOnError: true })
      await management.queryClient.invalidateQueries({ queryKey: keys.globalConfig })
    } catch (cause) {
      setShell(previous)
      setFailure(cause instanceof Error ? cause.message : "无法保存默认 Shell")
    } finally {
      setSaving(false)
    }
  }

  const unknownShell = () => {
    const current = shell()
    return current && !knownShells.includes(current as (typeof knownShells)[number]) ? current : undefined
  }

  return (
    <div class="settings-sections">
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <section class="settings-card" aria-labelledby="default-shell-title">
        <h3 id="default-shell-title">默认 Shell</h3>
        <p class="settings-description">用于新启动的终端和 Shell 工具；留空时使用系统默认值。</p>
        <label class="settings-select-label settings-select-label--active">
          <span>默认 Shell</span>
          <select
            aria-label="默认 Shell"
            value={shell()}
            disabled={config.isPending || saving()}
            onChange={(event) => void save(event.currentTarget.value)}
          >
            <option value="">系统默认</option>
            <Show when={unknownShell()}>{(value) => <option value={value()}>当前值：{value()}</option>}</Show>
            {knownShells.map((value) => <option value={value}>{value}</option>)}
          </select>
        </label>
        <Show when={config.error}>
          <InlineError message={config.error instanceof Error ? config.error.message : "无法读取全局配置"} />
        </Show>
      </section>

      <section class="settings-card" aria-labelledby="global-config-title">
        <h3 id="global-config-title">全局配置文件</h3>
        <p class="settings-description">在资源管理器中选中后端提供的 JYYCode 全局配置文件。</p>
        <GlobalConfigReveal management={management} />
      </section>

      <ComingSoonSetting title="自动更新" reason="桌面包尚未生成更新产物，也没有签名更新端点。">
        <label class="settings-select-label">
          <span>自动更新策略</span>
          <select aria-label="自动更新策略" disabled><option>仅提醒</option></select>
        </label>
      </ComingSoonSetting>
      <ComingSoonSetting title="上下文压缩参数" reason="部分压缩机制仍是占位实现，需要安全的产品默认值和参数验证。">
        <Button variant="secondary" disabled aria-label="配置上下文压缩参数">配置高级参数</Button>
      </ComingSoonSetting>
      <ComingSoonSetting title="记忆管理" reason="后端尚未提供适合桌面 UI 的安全、类型化记忆管理 API。">
        <Button variant="secondary" disabled aria-label="管理记忆">查看、清理和导出记忆</Button>
      </ComingSoonSetting>
    </div>
  )
}
