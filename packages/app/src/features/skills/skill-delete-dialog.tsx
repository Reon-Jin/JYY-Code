import { tr } from "../../i18n/i18n-context"
import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import type { ManagedSkill } from "./skill-query"

export function SkillDeleteDialog(props: {
  open: boolean
  skill: ManagedSkill
  sourceRemoval?: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  async function confirm() {
    setBusy(true)
    setError(undefined)
    try {
      await props.onConfirm()
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("skills.operation-failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      title={props.sourceRemoval ? tr("skills.remove-skill-source") : tr("skills.delete-skill")}
      description={`${props.skill.name} · ${props.skill.location}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button variant="danger" loading={busy()} loadingLabel={tr("skills.processing")} onClick={() => void confirm()}>
            {props.sourceRemoval ? tr("skills.confirm-removal") : tr("mcp.confirm-deletion")}
          </Button>
        </>
      }
    >
      <p class="skill-dialog__warning">
        {props.sourceRemoval
          ? tr("skills.this-source-will-be-removed-from-the-global")
          : tr("skills.this-action-will-delete-the-skill-from-the")}
      </p>
      <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
    </Dialog>
  )
}
