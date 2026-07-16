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
      title={`删除 MCP ${props.name}`}
      description="这会断开服务器、移除 OAuth 凭据并删除全局配置。"
      showClose
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" disabled={busy()} onClick={props.onClose}>
            取消
          </Button>
          <Button variant="danger" disabled={busy()} onClick={() => void remove()}>
            确认删除
          </Button>
        </>
      }
    >
      <Show when={failure()} keyed>
        {(cause) => <InlineError message={errorMessage(cause, "无法删除 MCP 配置")} />}
      </Show>
    </Dialog>
  )
}
