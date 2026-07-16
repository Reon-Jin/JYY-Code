import { tr } from "../../i18n/i18n-context"
import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"

export type McpDeleteDialogProps = {
  name: string
  onClose: () => void
  onDelete: () => Promise<void>
}

export function McpDeleteDialog(props: McpDeleteDialogProps) {
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()

  const remove = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      await props.onDelete()
      props.onClose()
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      class="mcp-delete-dialog"
      title={tr("mcp.delete-mcp-name", { name: props.name })}
      description={tr("mcp.this-disconnects-the-server-removes-the-oauth-credentials")}
      showClose
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" disabled={busy()} onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button variant="danger" disabled={busy()} onClick={() => void remove()}>
            {tr("mcp.confirm-deletion")}
          </Button>
        </>
      }
    >
      <Show when={failure()} keyed>
        {(cause) => <InlineError message={errorMessage(cause, tr("mcp.unable-to-delete-mcp-configuration"))} />}
      </Show>
    </Dialog>
  )
}
