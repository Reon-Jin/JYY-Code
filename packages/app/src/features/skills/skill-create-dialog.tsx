import { tr } from "../../i18n/i18n-context"
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"

export type SkillCreateInput = { name: string; description: string; content: string }

export function SkillCreateDialog(props: {
  open: boolean
  onClose: () => void
  onCreate: (input: SkillCreateInput) => Promise<void>
}) {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    if (!props.open) return
    setName("")
    setDescription("")
    setBody("")
    setError(undefined)
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const skillName = name().trim()
    const skillDescription = description().trim()
    if (!skillName) return setError(tr("skills.please-enter-skill-name"))
    if (!skillDescription) return setError(tr("skills.please-enter-skill-description"))
    const safeDescription = skillDescription.replace(/[\r\n]+/g, " ")
    const content = `---\nname: ${skillName}\ndescription: ${safeDescription}\n---\n\n${body()}`
    setBusy(true)
    setError(undefined)
    try {
      await props.onCreate({ name: skillName, description: safeDescription, content })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("skills.unable-to-create-skill"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      class="skill-dialog"
      title={tr("skills.new-skill")}
      description={tr("skills.create-a-skill-md-that-is-saved-in")}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button type="submit" form="skill-create-form" loading={busy()} loadingLabel={tr("projects.creating")}>
            {tr("github.create")}
          </Button>
        </>
      }
    >
      <form id="skill-create-form" class="skill-form" onSubmit={submit}>
        <label>
          {tr("mcp.name")}
          <input autofocus value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label>
          {tr("skills.describe")}
          <input value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        </label>
        <label>
          {tr("github.text")}
          <textarea rows={8} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </form>
    </Dialog>
  )
}
