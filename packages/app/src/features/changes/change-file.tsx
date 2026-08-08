import { tr } from "../../i18n/i18n-context"
import type { VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { ChevronDown, ChevronRight, FileCode2, Maximize2 } from "lucide-solid"
import { createEffect, For, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { parseUnifiedDiff, firstChangedLine } from "./unified-diff"

function statusLabel(status: VcsFileDiff["status"]) {
  switch (status) {
    case "added":
      return "A"
    case "deleted":
      return "D"
    default:
      return "M"
  }
}

export function ChangeFile(props: {
  change: VcsFileDiff
  expanded: boolean
  onToggle: () => void
  onOpenFile?: (change: VcsFileDiff) => void
}) {
  const diff = () => (props.expanded ? parseUnifiedDiff(props.change.patch) : undefined)
  let diffElement: HTMLPreElement | undefined

  createEffect(() => {
    if (!props.expanded) return
    const line = firstChangedLine(diff() ?? { hunks: [] })
    if (line === undefined) return
    const frame = requestAnimationFrame(() => {
      const target = diffElement?.querySelector<HTMLElement>('[data-kind="add"], [data-kind="delete"]')
      target?.scrollIntoView?.({ block: "nearest" })
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <li class="change-file" data-expanded={props.expanded ? "true" : "false"}>
      <div class="change-file__row">
        <button
          type="button"
          class="change-file__toggle"
          aria-expanded={props.expanded}
          aria-label={`${props.change.file}, +${props.change.additions} -${props.change.deletions}`}
          onClick={props.onToggle}
        >
          <Show when={props.expanded} fallback={<ChevronRight aria-hidden="true" />}>
            <ChevronDown aria-hidden="true" />
          </Show>
          <FileCode2 aria-hidden="true" />
          <span class="change-file__path">{props.change.file}</span>
          <span class="change-file__status" data-status={props.change.status ?? "modified"}>
            {statusLabel(props.change.status)}
          </span>
          <span class="change-file__stat">
            <b>+{props.change.additions}</b> <i>-{props.change.deletions}</i>
          </span>
        </button>
        <Show when={props.onOpenFile}>
          <Button
            class="change-file__open"
            size="icon"
            variant="ghost"
            aria-label={tr("files.open", { name: props.change.file })}
            onClick={(event) => {
              event.stopPropagation()
              props.onOpenFile?.(props.change)
            }}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
        </Show>
      </div>

      <Show when={props.expanded}>
        <Show
          when={(diff()?.hunks.length ?? 0) > 0}
          fallback={<p class="change-file__no-diff">{tr("changes.binary-file-or-no-text-to-display-diff")}</p>}
        >
          <pre ref={diffElement} class="change-file__diff" tabIndex={0} aria-label={`${props.change.file} Diff`}>
            <For each={diff()?.hunks ?? []}>
              {(hunk) => (
                <>
                  <span class="change-file__hunk">{hunk.header}</span>
                  <For each={hunk.lines}>
                    {(line) => (
                      <span class="change-file__line" data-kind={line.kind}>
                        <span class="change-file__line-number">{line.oldNumber ?? ""}</span>
                        <span class="change-file__line-number">{line.newNumber ?? ""}</span>
                        <span class="change-file__marker">
                          {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
                        </span>
                        <span class="change-file__line-content">{line.content}</span>
                      </span>
                    )}
                  </For>
                </>
              )}
            </For>
          </pre>
        </Show>
      </Show>
    </li>
  )
}
