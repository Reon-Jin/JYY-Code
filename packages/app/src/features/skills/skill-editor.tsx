import { tr } from "../../i18n/i18n-context"
import { useBeforeLeave } from "@solidjs/router"
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { ManagedSkill } from "./skill-query"

function isConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const value = cause as { name?: unknown; cause?: unknown; error?: unknown }
  return value.name === "SkillConflictError" || isConflict(value.cause) || isConflict(value.error)
}

export function SkillEditor(props: {
  skill: ManagedSkill
  onCancel: () => void
  onSave: (content: string, revision: string) => Promise<void>
}) {
  const [draft, setDraft] = createSignal(props.skill.content)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const dirty = () => draft() !== props.skill.content

  createEffect(() => {
    props.skill.revision
    setDraft(props.skill.content)
    setError(undefined)
  })

  useBeforeLeave((event) => {
    if (dirty() && !window.confirm(tr("skills.discard-unsaved-changes"))) event.preventDefault()
  })

  function cancel() {
    if (dirty() && !window.confirm(tr("skills.discard-unsaved-changes"))) return
    props.onCancel()
  }

  async function save() {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSave(draft(), props.skill.revision)
    } catch (cause) {
      setError(
        isConflict(cause)
          ? tr("skills.skill-has-been-modified-by-other-operations-the")
          : cause instanceof Error
            ? cause.message
            : tr("skills.unable-to-save-skill"),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="skill-editor" aria-label={tr("skills.skill-editor")}>
      <textarea
        aria-label="SKILL.md"
        value={draft()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "s") {
            event.preventDefault()
            void save()
          }
        }}
      />
      <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      <div class="skill-editor__actions">
        <Button variant="ghost" disabled={busy()} onClick={cancel}>
          {tr("github.cancel")}
        </Button>
        <Button loading={busy()} loadingLabel={tr("multi-agent.saving")} onClick={() => void save()}>
          {tr("github.save")}
        </Button>
      </div>
    </section>
  )
}
