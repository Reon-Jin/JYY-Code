import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { tr } from "../../i18n/i18n-context"

export function MemoryConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  async function confirm() {
    setBusy(true)
    setFailure(undefined)
    try {
      await props.onConfirm()
      props.onClose()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : tr("settings.memory-operation-error"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      title={props.title}
      description={props.description}
      showClose
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" disabled={busy()} onClick={props.onClose}>{tr("github.cancel")}</Button>
          <Button variant={props.danger ? "danger" : "primary"} loading={busy()} loadingLabel={tr("components.processing")} onClick={() => void confirm()}>{props.confirmLabel}</Button>
        </>
      }
    >
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
    </Dialog>
  )
}
