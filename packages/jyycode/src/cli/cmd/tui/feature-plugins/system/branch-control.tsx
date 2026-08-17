/** @jsxImportSource @opentui/solid */
// Git 分支控制 — 与 desktop features/git/branch-control.tsx 对齐。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.branch.list/create/switch、api.client.vcs.get/status）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, Show } from "solid-js"

export const ROUTE = "branches"

// ---------- 纯逻辑（可测） ----------

export function branchLabel(name: string, current: string | undefined): string {
  return name === current ? `* ${name}` : `  ${name}`
}

export function needsConfirmation(input: { dirty: boolean }): boolean {
  return input.dirty
}

// ---------- 视图 ----------

function BranchControlView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource(refresh, async () => {
    const [branchResult, statusResult] = await Promise.all([
      props.api.client.vcs.branch.list().catch(() => undefined),
      props.api.client.vcs.status().catch(() => undefined),
    ])
    const branches = branchResult?.data?.branches ?? []
    const current = branchResult?.data?.current
    const dirty = (statusResult?.data ?? []).length > 0
    return { branches, current, dirty }
  })

  const branches = () => data()?.branches ?? []
  const currentBranch = () => data()?.current
  const dirty = () => data()?.dirty ?? false
  const current = () => branches()[Math.min(selected(), Math.max(branches().length - 1, 0))]

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setRefresh((x) => x + 1)
  }

  async function switchBranch(name: string) {
    if (needsConfirmation({ dirty: dirty() })) {
      const ok = await new Promise<boolean>((resolve) => {
        props.api.ui.dialog.replace(() => (
          <props.api.ui.DialogConfirm
            title="切换分支"
            message={`工作区有未提交改动。确认切换到 "${name}"？`}
            onConfirm={() => resolve(true)}
            onCancel={() => resolve(false)}
          />
        ))
      })
      props.api.ui.dialog.clear()
      if (!ok) return
    }
    try {
      await props.api.client.vcs.branch.switch({ vcsSwitchBranchInput: { name } })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  function createBranch() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="新建分支"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入分支名（创建后立即切换）。</text>
          </box>
        )}
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (name) => {
          props.api.ui.dialog.clear()
          if (!name.trim()) return
          try {
            await props.api.client.vcs.branch.create({ vcsCreateBranchInput: { name: name.trim(), checkout: true } })
            await refreshAll()
          } catch (error) {
            toastError(error)
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
        group: "Branches",
        cmd() {
          props.api.route.navigate("session", {
            sessionID: "params" in props.api.route.current ? props.api.route.current.params?.sessionID : undefined,
          })
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Branches",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Branches",
        cmd() {
          setSelected((x) => Math.min(branches().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "切换",
        group: "Branches",
        cmd() {
          const branch = current()
          if (branch && !branch.current) void switchBranch(branch.name)
        },
      },
      {
        key: "b",
        desc: "新建分支",
        group: "Branches",
        cmd() {
          createBranch()
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "Branches",
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
          <b>分支</b>
        </text>
        <text fg={theme.textMuted}>
          {"  "}当前：{currentBranch() ?? "（无）"}
          {dirty() ? " · 工作区有未提交改动" : " · 工作区干净"}
        </text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={branches()}>
            {(branch, i) => {
              const isSelected = () => selected() === i()
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={branch.current ? theme.success : theme.textMuted} width={2}>
                    {branch.current ? "●" : " "}
                  </text>
                  <text fg={isSelected() && !branch.current ? theme.primary : branch.current ? theme.text : theme.textMuted} width={30}>
                    {branch.name}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1}>
                    {branch.kind === "remote" ? `远程${branch.remote ? ` (${branch.remote})` : ""}` : "本地"}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={branches().length === 0}>
            <box paddingTop={2}>
              <text fg={theme.textMuted}>无分支（非 Git 仓库？）。按 b 新建。</text>
            </box>
          </Show>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ 选择 · Enter 切换 · b 新建 · r 刷新 · Esc 返回</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <BranchControlView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "branches.show",
        title: "Git 分支",
        slashName: "branches",
        slashAliases: ["branch", "git-branch"],
        category: "VCS",
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
  id: "branch-control",
  tui,
}
