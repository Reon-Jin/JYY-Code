/** @jsxImportSource @opentui/solid */
// Skills 管理 — 与 desktop features/skills/* 对齐。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.app.skills / skill.create / skill.update / skill.delete / source.add / source.remove）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"

export const ROUTE = "skills"

export type SkillListItem = {
  id: string
  name: string
  description?: string
  location: string
  content: string
  origin: "built_in" | "managed" | "path" | "url" | "role"
  source?: string
  editable: boolean
  deletable: boolean
  revision: string
}

// ---------- 纯逻辑（可测） ----------

export function isBuiltinSkill(skill: Pick<SkillListItem, "origin">): boolean {
  return skill.origin === "built_in"
}

export function isRoleSkill(skill: Pick<SkillListItem, "origin">): boolean {
  return skill.origin === "role"
}

export function skillSourceType(source: string | undefined): string {
  if (!source) return "managed"
  if (source.startsWith("http://") || source.startsWith("https://")) return "url"
  return "path"
}

export function skillOriginLabel(origin: SkillListItem["origin"]): string {
  switch (origin) {
    case "built_in":
      return "内置"
    case "managed":
      return "托管"
    case "path":
      return "路径"
    case "url":
      return "远程"
    case "role":
      return "角色"
  }
}

export function parseSkillFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: "", body: content }
  return { frontmatter: match[1]!, body: content.slice(match[0].length) }
}

// ---------- 视图 ----------

function SkillsManageView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)
  const [detail, setDetail] = createSignal<SkillListItem | undefined>()

  const [data] = createResource(refresh, async () => {
    const result = await props.api.client.app.skills({ scope: "global" }).catch(() => undefined)
    const list = result?.data ?? []
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  })

  const entries = createMemo(() => data() ?? [])
  const current = createMemo(() => entries()[Math.min(selected(), Math.max(entries().length - 1, 0))])
  const active = createMemo(() => detail())

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setRefresh((x) => x + 1)
  }

  async function deleteSkill(skill: SkillListItem) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="删除 Skill"
          message={`确认删除 Skill "${skill.name}"？`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.skill.delete({ name: skill.name })
      setDetail(undefined)
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function createSkill() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="新建 Skill"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入 Skill 名称（字母数字与连字符）。</text>
          </box>
        )}
        placeholder="my-skill"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (name) => {
          props.api.ui.dialog.clear()
          if (!name.trim()) return
          try {
            const template = `---\nname: ${name.trim()}\ndescription: 由 TUI 创建。\n---\n\n# ${name.trim()}\n\n（编写该 Skill 的使用说明。模型会读取本文件作为技能提示词。）\n`
            await props.api.client.skill.create({ name: name.trim(), content: template })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  async function editSkill(skill: SkillListItem) {
    const value = await Editor.open({ value: skill.content, renderer: props.api.renderer })
    if (value === undefined || value === skill.content) return
    try {
      await props.api.client.skill.update({ name: skill.name, content: value, revision: skill.revision })
      setDetail(undefined)
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  function actionMenu(skill: SkillListItem) {
    const options = [
      { title: "查看详情", description: "浏览 SKILL.md 内容", value: "view" },
      ...(skill.editable ? [{ title: "编辑内容", description: "用外部编辑器修改 SKILL.md", value: "edit" }] : []),
      ...(skill.deletable ? [{ title: "删除", description: "删除该 Skill", value: "delete" }] : []),
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`操作：${skill.name}`}
        options={options}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          switch (option.value) {
            case "view":
              setDetail(skill)
              break
            case "edit":
              void editSkill(skill)
              break
            case "delete":
              void deleteSkill(skill)
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
        group: "Skills",
        cmd() {
          if (active()) setDetail(undefined)
          else props.api.route.navigate("home")
        },
      },
      ...(active()
        ? ([
            {
              key: "e",
              desc: "编辑内容",
              group: "Skills",
              cmd() {
                const skill = active()
                if (skill?.editable) void editSkill(skill)
              },
            },
            {
              key: "d",
              desc: "删除",
              group: "Skills",
              cmd() {
                const skill = active()
                if (skill?.deletable) void deleteSkill(skill)
              },
            },
          ] as const)
        : ([
            {
              key: "up",
              desc: "上移",
              group: "Skills",
              cmd() {
                setSelected((x) => Math.max(0, x - 1))
              },
            },
            {
              key: "down",
              desc: "下移",
              group: "Skills",
              cmd() {
                setSelected((x) => Math.min(entries().length - 1, x + 1))
              },
            },
            {
              key: "enter",
              desc: "操作菜单",
              group: "Skills",
              cmd() {
                const skill = current()
                if (skill) actionMenu(skill)
              },
            },
            {
              key: "a",
              desc: "新建",
              group: "Skills",
              cmd() {
                void createSkill()
              },
            },
            {
              key: "r",
              desc: "刷新",
              group: "Skills",
              cmd() {
                void refreshAll()
              },
            },
          ] as const)),
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      flexDirection="column"
    >
      <Switch>
        <Match when={active()}>
          {(skill) => (
            <>
              <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
                <text fg={theme.text}>
                  <b>{skill().name}</b>
                </text>
                <text fg={theme.textMuted}>
                  {"  "}
                  {skillOriginLabel(skill().origin)} · {skill().location}
                </text>
              </box>
              <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
                <For each={skill().content.split("\n")}>
                  {(line) => (
                    <text fg={theme.text}>
                      {line || " "}
                    </text>
                  )}
                </For>
              </scrollbox>
              <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
                <text fg={theme.textMuted}>
                  Esc 返回 · e 编辑{skill().editable ? "" : "（只读）"} · d 删除
                  {skill().deletable ? "" : "（不可删）"}
                </text>
              </box>
            </>
          )}
        </Match>
        <Match when={!active()}>
          <>
            <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
              <text fg={theme.text}>
                <b>Skill 管理</b>
              </text>
              <text fg={theme.textMuted}>  — 全局生效 Skill 集合（托管于 ~/.jyycode/skills）</text>
            </box>
            <Show when={data.loading}>
              <box paddingLeft={2} paddingTop={1}>
                <text fg={theme.textMuted}>加载中…</text>
              </box>
            </Show>
            <Show when={!data.loading}>
              <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
                <For each={entries()}>
                  {(skill, i) => {
                    const isSelected = () => selected() === i()
                    const originColor = () => {
                      if (isBuiltinSkill(skill)) return theme.textMuted
                      if (isRoleSkill(skill)) return theme.warning
                      return theme.primary
                    }
                    return (
                      <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                        <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                          {isSelected() ? "›" : " "}
                        </text>
                        <text fg={isSelected() ? theme.primary : theme.text} width={24}>
                          {skill.name}
                        </text>
                        <text fg={originColor()} width={6}>
                          {skillOriginLabel(skill.origin)}
                        </text>
                        <text fg={theme.textMuted} flexGrow={1}>
                          {skill.description?.replace(/\s+/g, " ").trim() ?? ""}
                        </text>
                      </box>
                    )
                  }}
                </For>
                <Switch>
                  <Match when={!data.loading && entries().length === 0}>
                    <box paddingTop={2}>
                      <text fg={theme.textMuted}>暂无 Skill。按 a 新建。</text>
                    </box>
                  </Match>
                </Switch>
              </scrollbox>
            </Show>
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
              <text fg={theme.textMuted}>
                ↑/↓ 选择 · Enter 操作 · a 新建 · r 刷新 · Esc 返回
              </text>
            </box>
          </>
        </Match>
      </Switch>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <SkillsManageView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "skills.manage",
        title: "Skill 管理（全局）",
        slashName: "skills",
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
  id: "skills-manage",
  tui,
}
