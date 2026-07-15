import type { Session } from "@jyycode-ai/sdk/v2/client"
import { Archive, Ellipsis, Pencil, Trash2 } from "lucide-solid"
import { createEffect, createSignal, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"

export type SessionActionsProps = {
  session: Session
  archived: boolean
  disabled?: boolean
  onRename: () => void
  onArchive: () => Promise<void>
  onDelete: () => Promise<void>
}

export function SessionActions(props: SessionActionsProps) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [deleteOpen, setDeleteOpen] = createSignal(false)
  const [busy, setBusy] = createSignal<"archive" | "delete">()
  const [error, setError] = createSignal<string>()
  const [menuPosition, setMenuPosition] = createSignal({ top: 0, left: 0 })
  let trigger: HTMLButtonElement | undefined
  let firstItem: HTMLButtonElement | undefined

  createEffect(() => {
    if (menuOpen()) queueMicrotask(() => firstItem?.focus())
  })

  function closeMenu() {
    setMenuOpen(false)
    queueMicrotask(() => trigger?.focus())
  }

  async function archive() {
    setBusy("archive")
    setError(undefined)
    try {
      await props.onArchive()
      closeMenu()
    } catch (cause) {
      setError(errorMessage(cause, "无法归档 Session"))
    } finally {
      setBusy(undefined)
    }
  }

  async function remove() {
    setBusy("delete")
    setError(undefined)
    try {
      await props.onDelete()
      setDeleteOpen(false)
    } catch (cause) {
      setError(errorMessage(cause, "无法删除 Session"))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div
      class="session-actions"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menuOpen()) return
        event.preventDefault()
        closeMenu()
      }}
    >
      <IconButton
        ref={trigger}
        label={`Session 操作：${props.session.title}`}
        variant="ghost"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        onClick={() => {
          setError(undefined)
          if (!menuOpen() && trigger) {
            const bounds = trigger.getBoundingClientRect()
            const menuHeight = props.archived ? 96 : 132
            const below = bounds.bottom + 4
            setMenuPosition({
              top: below + menuHeight <= window.innerHeight ? below : Math.max(8, bounds.top - menuHeight - 4),
              left: Math.max(8, bounds.right - 164),
            })
          }
          setMenuOpen((open) => !open)
        }}
      >
        <Ellipsis aria-hidden="true" />
      </IconButton>

      <Show when={menuOpen()}>
        <div
          class="session-actions__menu"
          role="menu"
          aria-label={`${props.session.title} 操作`}
          style={{ top: `${menuPosition().top}px`, left: `${menuPosition().left}px` }}
        >
          <Button
            ref={firstItem}
            role="menuitem"
            variant="ghost"
            size="small"
            onClick={() => {
              closeMenu()
              props.onRename()
            }}
          >
            <Pencil aria-hidden="true" />
            重命名
          </Button>
          <Show when={!props.archived}>
            <Button
              role="menuitem"
              variant="ghost"
              size="small"
              loading={busy() === "archive"}
              loadingLabel="正在归档"
              onClick={() => void archive()}
            >
              <Archive aria-hidden="true" />
              归档
            </Button>
          </Show>
          <Button
            role="menuitem"
            variant="ghost"
            size="small"
            onClick={() => {
              setMenuOpen(false)
              setDeleteOpen(true)
              setError(undefined)
            }}
          >
            <Trash2 aria-hidden="true" />
            删除
          </Button>
          <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
        </div>
      </Show>

      <Dialog
        open={deleteOpen()}
        title="删除 Session"
        description="此操作会永久删除该 Session 及其对话记录，无法撤销。"
        onClose={() => {
          if (busy() !== "delete") setDeleteOpen(false)
        }}
        footer={
          <>
            <Button variant="ghost" disabled={busy() === "delete"} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy() === "delete"}
              loadingLabel="正在删除"
              onClick={() => void remove()}
            >
              永久删除
            </Button>
          </>
        }
      >
        <p class="session-delete-copy">
          即将删除 <strong>{props.session.title}</strong>
        </p>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </Dialog>
    </div>
  )
}
