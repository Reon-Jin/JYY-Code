import { tr } from "../../i18n/i18n-context"
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"

export type SkillSourceInput = { type: "path" | "url"; value: string }

export function SkillSourceDialog(props: {
  open: boolean
  onClose: () => void
  onAdd: (input: SkillSourceInput) => Promise<void>
}) {
  const [type, setType] = createSignal<"path" | "url">("path")
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    if (!props.open) return
    setType("path")
    setValue("")
    setError(undefined)
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const source = value().trim()
    if (!source) return setError(type() === "path" ? tr("skills.please-enter-local-path") : tr("skills.please-enter-url"))
    setBusy(true)
    setError(undefined)
    try {
      await props.onAdd({ type: type(), value: source })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("skills.unable-to-add-skill-source"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      class="skill-dialog"
      title={tr("skills.add-skill-source")}
      description={tr("skills.add-a-local-directory-or-remote-url-that")}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button type="submit" form="skill-source-form" loading={busy()} loadingLabel={tr("skills.adding")}>
            {tr("skills.add-to")}
          </Button>
        </>
      }
    >
      <form id="skill-source-form" class="skill-form" onSubmit={submit}>
        <label>
          {tr("mcp.type")}
          <select value={type()} onChange={(event) => setType(event.currentTarget.value as "path" | "url")}>
            <option value="path">{tr("skills.local-path")}</option>
            <option value="url">URL</option>
          </select>
        </label>
        <label>
          {type() === "path" ? tr("skills.path") : "URL"}
          <input autofocus value={value()} onInput={(event) => setValue(event.currentTarget.value)} />
        </label>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </form>
    </Dialog>
  )
}
