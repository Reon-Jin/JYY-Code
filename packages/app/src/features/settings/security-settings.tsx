import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { displayDefaultPermission, type DefaultPermissionMode } from "./default-permission"
import { GlobalConfigReveal } from "./global-config-reveal"

type SimpleMode = Exclude<DefaultPermissionMode, "custom">

const options: Array<{ mode: SimpleMode; description: string }> = [
  { mode: "auto", description: "使用 JYYCode 的安全默认行为。" },
  { mode: "request", description: "每次需要使用工具权限时都先询问。" },
  { mode: "full", description: "允许工具直接执行，适合受信任的环境。" },
]

export function SecuritySettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const permission = createQuery(
    () => ({
      queryKey: keys.globalDefaultPermission,
      queryFn: async () => {
        const response = await management.client.global.defaultPermission.get({ throwOnError: true })
        if (!response.data) throw new Error("后端未返回默认权限")
        return response.data
      },
    }),
    () => management.queryClient,
  )
  const [selected, setSelected] = createSignal<DefaultPermissionMode>("auto")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [pendingMode, setPendingMode] = createSignal<SimpleMode>()

  createEffect(() => {
    if (permission.data && !saving()) setSelected(permission.data.mode)
  })

  async function save(mode: SimpleMode) {
    const previous = selected()
    setPendingMode(undefined)
    setFailure(undefined)
    setSelected(mode)
    setSaving(true)
    try {
      await management.client.global.defaultPermission.update({ mode }, { throwOnError: true })
      await Promise.all([
        management.queryClient.invalidateQueries({ queryKey: keys.globalDefaultPermission }),
        management.queryClient.invalidateQueries({ queryKey: keys.globalConfig }),
      ])
    } catch (cause) {
      setSelected(previous)
      setFailure(cause instanceof Error ? cause.message : "无法保存默认权限")
    } finally {
      setSaving(false)
    }
  }

  function choose(mode: SimpleMode) {
    if (selected() === "custom") {
      setPendingMode(mode)
      return
    }
    void save(mode)
  }

  return (
    <div class="settings-sections">
      <p class="settings-scope-note">仅应用于新建的 Session；现有 Session 保留各自的权限选择。</p>
      <Show when={permission.isPending}>
        <p role="status">正在读取默认权限…</p>
      </Show>
      <Show when={permission.error}>
        <InlineError message={permission.error instanceof Error ? permission.error.message : "无法读取默认权限"} />
      </Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={!permission.isPending && !permission.error}>
        <section class="settings-card" aria-labelledby="default-permission-title">
          <h3 id="default-permission-title">新 Session 默认权限</h3>
          <fieldset class="settings-options" disabled={saving()}>
            <legend>选择新 Session 的默认权限</legend>
            <For each={options}>
              {(option) => (
                <label>
                  <input
                    type="radio"
                    name="default-permission"
                    aria-label={displayDefaultPermission(option).label}
                    checked={selected() === option.mode}
                    onChange={() => choose(option.mode)}
                  />
                  <span>
                    <strong>{displayDefaultPermission(option).label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              )}
            </For>
          </fieldset>
          <Show when={selected() === "custom"}>
            <div class="settings-custom-permission" role="status">
              <strong>自定义配置</strong>
              <p>当前全局配置包含细粒度规则。选择上方策略前需要确认替换。</p>
              <GlobalConfigReveal management={management} />
            </div>
          </Show>
          <Show when={saving()}><p class="settings-saving" role="status">正在保存…</p></Show>
        </section>
      </Show>

      <Dialog
        open={Boolean(pendingMode())}
        title="替换自定义权限"
        description="继续后，现有细粒度权限规则将被所选的简单策略替换。"
        onClose={() => setPendingMode(undefined)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingMode(undefined)}>取消</Button>
            <Button onClick={() => { const mode = pendingMode(); if (mode) void save(mode) }}>替换并继续</Button>
          </>
        }
      >
        <p>此操作只改变新 Session 的默认权限，不会修改已经存在的 Session。</p>
      </Dialog>
    </div>
  )
}
