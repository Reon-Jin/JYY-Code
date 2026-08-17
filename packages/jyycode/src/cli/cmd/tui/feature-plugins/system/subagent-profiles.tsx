/** @jsxImportSource @opentui/solid */
// Subagent profiles 面板 — 与 desktop features/subagents/subagent-profiles-panel.tsx 对齐。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.subagents.list/update/delete/skillCreate）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { SubagentProfile } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { createResource, createSignal, For, Show } from "solid-js"

export const ROUTE = "subagents"

export const AVATAR_IDS = ["bot", "search", "code", "bug", "chart", "file", "image", "folder", "pen", "sparkles"] as const

// ---------- 纯逻辑（可测） ----------

export type ProfileForm = {
  name: string
  description: string
  prompt: string
  avatar: SubagentProfile["avatar"]
  enabled: boolean
}

export function profileForm(profile: SubagentProfile): ProfileForm {
  return {
    name: profile.name,
    description: profile.description,
    prompt: profile.prompt,
    avatar: profile.avatar,
    enabled: profile.enabled,
  }
}

export function validateProfile(form: ProfileForm): { name?: string; prompt?: string } {
  const errors: { name?: string; prompt?: string } = {}
  if (!form.name.trim()) errors.name = "名称不能为空"
  if (!form.prompt.trim()) errors.prompt = "启动提示词不能为空"
  return errors
}

export function avatarOptions(): ReadonlyArray<SubagentProfile["avatar"]> {
  return AVATAR_IDS
}

// ---------- 视图 ----------

function SubagentProfilesView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource(refresh, async () => {
    const result = await props.api.client.subagents.list().catch(() => undefined)
    return (result?.data ?? []).sort((a, b) => a.name.localeCompare(b.name))
  })

  const profiles = () => data() ?? []
  const current = () => profiles()[Math.min(selected(), Math.max(profiles().length - 1, 0))]

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setSelected(0)
    setRefresh((x) => x + 1)
  }

  async function saveProfiles(next: SubagentProfile[]) {
    try {
      await props.api.client.subagents.update({ subagentProfilesUpdate: { profiles: next } })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function toggleEnabled(profile: SubagentProfile) {
    const next = profiles().map((item) => (item.id === profile.id ? { ...item, enabled: !item.enabled } : item))
    await saveProfiles(next)
  }

  async function editProfile(profile: SubagentProfile) {
    const prompt = await Editor.open({ value: profile.prompt, renderer: props.api.renderer })
    if (prompt === undefined || prompt === profile.prompt) return
    const next = profiles().map((item) => (item.id === profile.id ? { ...item, prompt } : item))
    await saveProfiles(next)
  }

  async function deleteProfile(profile: SubagentProfile) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="删除 Subagent"
          message={`确认删除 profile "${profile.name}"？将同时删除其私有 Skill 目录。`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    const next = profiles().filter((item) => item.id !== profile.id)
    await saveProfiles(next)
  }

  function createProfile() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="新建 Subagent profile"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入名称（随后编辑启动提示词与描述）。</text>
          </box>
        )}
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (name) => {
          props.api.ui.dialog.clear()
          if (!name.trim()) return
          const next: SubagentProfile[] = [
            ...profiles(),
            {
              id: `role_${Date.now().toString(36)}`,
              name: name.trim(),
              description: "",
              prompt: `You are ${name.trim()}.`,
              avatar: "bot",
              enabled: true,
            },
          ]
          await saveProfiles(next)
        }}
      />
    ))
  }

  function actionMenu(profile: SubagentProfile) {
    const options = [
      {
        title: profile.enabled ? "停用" : "启用",
        description: "切换该 profile 的启用状态",
        value: "toggle",
      },
      { title: "编辑启动提示词", description: "用外部编辑器修改 prompt", value: "edit" },
      { title: "删除", description: "删除该 profile", value: "delete" },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`操作：${profile.name}`}
        options={options}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          switch (option.value) {
            case "toggle":
              void toggleEnabled(profile)
              break
            case "edit":
              void editProfile(profile)
              break
            case "delete":
              void deleteProfile(profile)
              break
          }
        }}
      />
    ))
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Subagents",
        cmd() {
          props.api.route.navigate("home")
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Subagents",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Subagents",
        cmd() {
          setSelected((x) => Math.min(profiles().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "操作菜单",
        group: "Subagents",
        cmd() {
          const profile = current()
          if (profile) actionMenu(profile)
        },
      },
      {
        key: "a",
        desc: "新建",
        group: "Subagents",
        cmd() {
          createProfile()
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "Subagents",
        cmd() {
          void refreshAll()
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>Subagent profiles</b>
        </text>
        <text fg={theme.textMuted}>  — 项目多智能体角色配置（变更不打断已运行任务）</text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={profiles()}>
            {(profile, i) => {
              const isSelected = () => selected() === i()
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                    {isSelected() ? "›" : " "}
                  </text>
                  <text fg={profile.enabled ? theme.success : theme.textMuted} width={2}>
                    {profile.enabled ? "●" : "○"}
                  </text>
                  <text fg={isSelected() ? theme.primary : theme.text} width={20}>
                    {profile.name}
                  </text>
                  <text fg={theme.textMuted} width={12}>
                    {profile.avatar}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1}>
                    {profile.description || (profile.prompt.split("\n")[0] ?? "")}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={profiles().length === 0}>
            <box paddingTop={2}>
              <text fg={theme.textMuted}>暂无 subagent profiles。按 a 新建。</text>
            </box>
          </Show>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ 选择 · Enter 操作 · a 新建 · r 刷新 · Esc 返回</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <SubagentProfilesView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "subagents.show",
        title: "Subagent profiles",
        slashName: "subagents",
        category: "Agent",
        namespace: "palette",
        run() {
          api.route.navigate(ROUTE)
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

export default {
  id: "subagents-panel",
  tui,
}
