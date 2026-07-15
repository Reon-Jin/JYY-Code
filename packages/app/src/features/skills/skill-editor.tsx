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
    if (dirty() && !window.confirm("放弃未保存的更改？")) event.preventDefault()
  })

  function cancel() {
    if (dirty() && !window.confirm("放弃未保存的更改？")) return
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
          ? "Skill 已被其他操作修改；草稿已保留，请重新加载后再保存。"
          : cause instanceof Error
            ? cause.message
            : "无法保存 Skill",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="skill-editor" aria-label="Skill 编辑器">
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
          取消
        </Button>
        <Button loading={busy()} loadingLabel="正在保存" onClick={() => void save()}>
          保存
        </Button>
      </div>
    </section>
  )
}
