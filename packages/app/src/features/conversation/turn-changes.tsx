import type { SnapshotFileDiff, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { ChevronDown, ChevronUp, FileDiff } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { useOptionalData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { ChangeFile } from "../changes/change-file"
import { previewKind } from "../files/file-types"
import { MediaPreview } from "./media-preview"
import type { ConversationMessage } from "./conversation-state"
import type { PresentedConversationMessage } from "./message-presentation"
import "../changes/changes-panel.css"

export type TurnChangeSummary = {
  messageID: string
  directory?: string
  changes: readonly SnapshotFileDiff[]
  inlineMediaNames?: readonly string[]
  inlineImageCount?: number
}

/** Anchor a persisted user-turn summary after its final visible assistant group. */
export function turnChangeSummaries(
  messages: readonly ConversationMessage[],
  presented: readonly PresentedConversationMessage[],
  running: boolean,
) {
  const owners = new Map<string, string>()
  const visibleUsers = new Set<string>()
  for (const message of presented) {
    if (message.info.role === "user") visibleUsers.add(message.info.id)
    else {
      owners.set(message.info.id, message.info.id)
      for (const group of message.groups) for (const part of group.parts) owners.set(part.messageID, message.info.id)
    }
  }
  const lastUser = [...visibleUsers].at(-1)
  const assistants = new Map<string, ConversationMessage[]>()
  for (const message of messages)
    if (message.info.role === "assistant") {
      const list = assistants.get(message.info.parentID) ?? []
      list.push(message)
      assistants.set(message.info.parentID, list)
    }
  const result = new Map<string, TurnChangeSummary>()
  for (const message of messages) {
    if (message.info.role !== "user" || !visibleUsers.has(message.info.id) || message.info.summary?.diffs === undefined)
      continue
    const replies = assistants.get(message.info.id) ?? []
    const latest = replies.at(-1)
    if (
      !latest ||
      (message.info.id === lastUser &&
        (running || latest.info.role !== "assistant" || latest.info.time.completed === undefined))
    )
      continue
    const anchor = [...replies]
      .reverse()
      .map((reply) => owners.get(reply.info.id))
      .find((id) => id !== undefined)
    if (!anchor) continue
    // Snapshot diff paths are relative to the worktree. Non-git sessions use
    // "/" as a legacy worktree sentinel and must stay scoped to their cwd.
    const directory =
      latest.info.role === "assistant"
        ? latest.info.path.root && latest.info.path.root !== "/"
          ? latest.info.path.root
          : latest.info.path.cwd
        : undefined
    const inlineMedia = replies
      .flatMap((reply) => reply.parts)
      .filter((part) => part.type === "file" && /^(image|audio|video)\//.test(part.mime))
    result.set(anchor, {
      messageID: message.info.id,
      directory,
      inlineMediaNames: inlineMedia.flatMap((part) => (part.type === "file" && part.filename ? [part.filename] : [])),
      inlineImageCount: inlineMedia.filter((part) => part.type === "file" && part.mime.startsWith("image/")).length,
      changes: message.info.summary.diffs.filter(
        (change) => !change.file?.replaceAll("\\", "/").split("/").includes(".jyycode"),
      ),
    })
  }
  return result
}

export function TurnChanges(props: { summary: TurnChangeSummary }) {
  const data = useOptionalData()
  const [showAll, setShowAll] = createSignal(false)
  const [showAllImages, setShowAllImages] = createSignal(false)
  const [showAllMedia, setShowAllMedia] = createSignal(false)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const changes = createMemo<VcsFileDiff[]>(() =>
    props.summary.changes.map((change) => ({
      ...change,
      file: change.file ?? tr("conversation.file-name-unavailable"),
    })),
  )
  const visible = () => (showAll() ? changes() : changes().slice(0, 5))
  const mediaChanges = () =>
    changes().filter(
      (change) =>
        change.status !== "deleted" && !(props.summary.inlineMediaNames ?? []).some((name) => name === change.file),
    )
  const images = createMemo(() => mediaChanges().filter((change) => previewKind(change.file) === "image"))
  const imageLimit = () => Math.max(0, 4 - (props.summary.inlineImageCount ?? 0))
  const otherMedia = createMemo(() =>
    mediaChanges().filter((change) => ["audio", "video"].includes(previewKind(change.file))),
  )
  const mediaUrl = (file: string) => {
    if (!data) return undefined
    const url = new URL(data.fileMediaUrl(file, data.workspaceID(), props.summary.directory))
    url.searchParams.set("version", props.summary.messageID)
    return url.toString()
  }
  const toggle = (file: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  return (
    <section class="turn-changes" aria-label={tr("conversation.turn-changes")}>
      <Show
        when={changes().length > 0}
        fallback={<p class="turn-changes__empty">{tr("conversation.no-file-changes")}</p>}
      >
        <header class="turn-changes__header">
          <FileDiff aria-hidden="true" />
          <div>
            <strong>{tr("conversation.changed-files", { count: changes().length })}</strong>
            <span class="change-file__stat">
              <b>+{changes().reduce((sum, change) => sum + change.additions, 0)}</b>
              <i>-{changes().reduce((sum, change) => sum + change.deletions, 0)}</i>
            </span>
          </div>
          <Button
            size="small"
            variant="secondary"
            onClick={() => {
              if (expanded().size) setExpanded(new Set<string>())
              else {
                setShowAll(true)
                setExpanded(
                  new Set(
                    changes()
                      .slice(0, 1)
                      .map((change) => change.file),
                  ),
                )
              }
            }}
          >
            {tr(expanded().size ? "conversation.hide-changes" : "conversation.view-changes")}
          </Button>
        </header>
        <ul class="turn-changes__files">
          <For each={visible()}>
            {(change) => (
              <ChangeFile change={change} expanded={expanded().has(change.file)} onToggle={() => toggle(change.file)} />
            )}
          </For>
        </ul>
        <Show when={changes().length > 5}>
          <button
            class="turn-changes__more"
            type="button"
            aria-expanded={showAll()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll()
              ? tr("conversation.collapse-files")
              : tr("conversation.more-files", { count: changes().length - 5 })}
            <Show when={showAll()} fallback={<ChevronDown aria-hidden="true" />}>
              <ChevronUp aria-hidden="true" />
            </Show>
          </button>
        </Show>
        <Show when={data && images().length > 0}>
          <div class="turn-changes__images">
            <For each={showAllImages() ? images() : images().slice(0, imageLimit())}>
              {(change) => <MediaPreview kind="image" name={change.file} src={mediaUrl(change.file)} />}
            </For>
          </div>
          <Show when={images().length > imageLimit()}>
            <button
              type="button"
              class="turn-changes__more"
              aria-expanded={showAllImages()}
              onClick={() => setShowAllImages((value) => !value)}
            >
              {showAllImages()
                ? tr("conversation.collapse-images")
                : tr("conversation.more-images", { count: images().length - imageLimit() })}
            </button>
          </Show>
        </Show>
        <Show when={data && otherMedia().length > 0}>
          <div class="turn-changes__media">
            <For each={showAllMedia() ? otherMedia() : otherMedia().slice(0, 5)}>
              {(change) => (
                <MediaPreview
                  kind={previewKind(change.file) === "audio" ? "audio" : "video"}
                  name={change.file}
                  src={mediaUrl(change.file)}
                />
              )}
            </For>
          </div>
          <Show when={otherMedia().length > 5}>
            <button
              type="button"
              class="turn-changes__more"
              aria-expanded={showAllMedia()}
              onClick={() => setShowAllMedia((value) => !value)}
            >
              {showAllMedia()
                ? tr("conversation.collapse-media")
                : tr("conversation.more-media", { count: otherMedia().length - 5 })}
            </button>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
