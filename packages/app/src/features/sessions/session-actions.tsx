import { tr } from "../../i18n/i18n-context"
import type { Session } from "@jyycode-ai/sdk/v2/client"
import { Archive, Ellipsis, Pencil, Trash2 } from "lucide-solid"
import { createEffect, createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Button, IconButton } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"
import { displaySessionTitle } from "./session-title"

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

  function handleMenuKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return
    event.preventDefault()
    closeMenu()
  }

  async function archive() {
    setBusy("archive")
    setError(undefined)
    try {
      await props.onArchive()
      closeMenu()
    } catch (cause) {
      setError(errorMessage(cause, tr("sessions.unable-to-archive-session")))
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
      setError(errorMessage(cause, tr("sessions.unable-to-delete-session")))
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
        label={tr("sessions.actions-for-title", { title: displaySessionTitle(props.session.title) })}
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
        <Portal mount={document.body}>
          <div
            class="session-actions__menu"
            role="menu"
            aria-label={tr("sessions.title-actions", { title: displaySessionTitle(props.session.title) })}
            style={{ top: `${menuPosition().top}px`, left: `${menuPosition().left}px` }}
            onKeyDown={handleMenuKeyDown}
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
              {tr("sessions.rename")}
            </Button>
            <Show when={!props.archived}>
              <Button
                role="menuitem"
                variant="ghost"
                size="small"
                loading={busy() === "archive"}
                loadingLabel={tr("sessions.archiving")}
                onClick={() => void archive()}
              >
                <Archive aria-hidden="true" />
                {tr("sessions.archive")}
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
              {tr("mcp.delete")}
            </Button>
            <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
          </div>
        </Portal>
      </Show>

      <Dialog
        open={deleteOpen()}
        title={tr("sessions.delete-session")}
        description={tr("sessions.this-operation-will-permanently-delete-the-session-and")}
        onClose={() => {
          if (busy() !== "delete") setDeleteOpen(false)
        }}
        footer={
          <>
            <Button variant="ghost" disabled={busy() === "delete"} onClick={() => setDeleteOpen(false)}>
              {tr("github.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy() === "delete"}
              loadingLabel={tr("sessions.deleting")}
              onClick={() => void remove()}
            >
              {tr("sessions.delete-permanently")}
            </Button>
          </>
        }
      >
        <p class="session-delete-copy">
          {tr("sessions.about-to-be-deleted")} <strong>{displaySessionTitle(props.session.title)}</strong>
        </p>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </Dialog>
    </div>
  )
}
