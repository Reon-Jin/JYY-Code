import { X } from "lucide-solid"
import { createEffect, createUniqueId, onCleanup, Show, type JSX, type ParentProps } from "solid-js"

export type DialogProps = ParentProps<{
  open: boolean
  class?: string
  title: string
  description?: string
  footer?: JSX.Element
  showClose?: boolean
  onClose: () => void
}>

export function Dialog(props: DialogProps) {
  const titleID = createUniqueId()
  const descriptionID = createUniqueId()
  let dialog: HTMLDialogElement | undefined
  let restoreFocus: HTMLElement | undefined

  const returnFocus = () => {
    restoreFocus?.focus()
    restoreFocus = undefined
  }

  createEffect(() => {
    if (!dialog) return
    if (props.open && !dialog.open) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      dialog.showModal()
      queueMicrotask(() => dialog?.querySelector<HTMLElement>("[autofocus], button, input, select, textarea")?.focus())
      return
    }
    if (!props.open && dialog.open) {
      dialog.close()
      returnFocus()
    }
  })

  onCleanup(() => {
    if (dialog?.open) dialog.close()
    returnFocus()
  })

  return (
    <dialog
      ref={dialog}
      class={["ui-dialog", props.class].filter(Boolean).join(" ")}
      aria-labelledby={titleID}
      aria-describedby={props.description ? descriptionID : undefined}
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
      onClose={returnFocus}
    >
      <header class="ui-dialog__header">
        <h2 class="ui-dialog__title" id={titleID}>
          {props.title}
        </h2>
        <Show when={props.description}>
          <p class="ui-dialog__description" id={descriptionID}>
            {props.description}
          </p>
        </Show>
        <Show when={props.showClose}>
          <button type="button" class="ui-dialog__close" aria-label="关闭" onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </Show>
      </header>
      <section class="ui-dialog__content">{props.children}</section>
      <Show when={props.footer}>
        <footer class="ui-dialog__footer">{props.footer}</footer>
      </Show>
    </dialog>
  )
}
