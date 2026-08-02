import { Bot, Bug, ChartBar, Code, File, Folder, Image, Pen, Search, Sparkles } from "lucide-solid"
import type { Component } from "solid-js"
import { tr } from "../../i18n/i18n-context"

export const SUBAGENT_AVATAR_IDS = [
  "bot",
  "search",
  "code",
  "bug",
  "chart",
  "file",
  "image",
  "folder",
  "pen",
  "sparkles",
] as const

export type SubagentAvatarID = (typeof SUBAGENT_AVATAR_IDS)[number]

const icons: Record<SubagentAvatarID, Component<{ size?: number; class?: string }>> = {
  bot: Bot,
  search: Search,
  code: Code,
  bug: Bug,
  chart: ChartBar,
  file: File,
  image: Image,
  folder: Folder,
  pen: Pen,
  sparkles: Sparkles,
}

const labels: Record<SubagentAvatarID, string> = {
  bot: "subagents.avatar-bot",
  search: "subagents.avatar-search",
  code: "subagents.avatar-code",
  bug: "subagents.avatar-bug",
  chart: "subagents.avatar-chart",
  file: "subagents.avatar-file",
  image: "subagents.avatar-image",
  folder: "subagents.avatar-folder",
  pen: "subagents.avatar-pen",
  sparkles: "subagents.avatar-sparkles",
}

export function subagentAvatarLabel(id: SubagentAvatarID) {
  return tr(labels[id] as Parameters<typeof tr>[0])
}

export function SubagentAvatar(props: { id: SubagentAvatarID; size?: number; class?: string }) {
  const Icon = icons[props.id]
  return <Icon size={props.size ?? 18} class={props.class} aria-hidden="true" />
}
