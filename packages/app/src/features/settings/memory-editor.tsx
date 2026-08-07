import type { GlobalMemoryEntry } from "@jyycode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { tr } from "../../i18n/i18n-context"

export type MemoryEditorValue = {
  importance: number
  keywords: string[]
  content: string
  kind?: "success" | "failure" | "lesson"
  confidence?: "low" | "medium" | "high"
}

export function MemoryEditor(props: {
  open: boolean
  entry?: GlobalMemoryEntry
  onClose: () => void
  onSave: (value: MemoryEditorValue) => Promise<void>
}) {
  const [importance, setImportance] = createSignal("5")
  const [keywords, setKeywords] = createSignal("")
  const [content, setContent] = createSignal("")
  const [kind, setKind] = createSignal<"success" | "failure" | "lesson">("lesson")
  const [confidence, setConfidence] = createSignal<"low" | "medium" | "high">("medium")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  createEffect(() => {
    if (!props.open) return
    setImportance(String(props.entry?.importance ?? 5))
    setKeywords(props.entry?.keywords.join(", ") ?? "")
    setContent(props.entry?.content ?? "")
    setKind(props.entry?.scope === "experience" ? props.entry.kind : "lesson")
    setConfidence(props.entry?.scope === "experience" ? props.entry.confidence : "medium")
    setFailure(undefined)
  })

  const parsed = createMemo(() => {
    const value = Number(importance())
    if (!Number.isInteger(value) || value < 1 || value > 10) return { error: tr("settings.memory-importance-error") }
    const list = keywords()
      .split(/[,，、]/u)
      .map((item) => item.normalize("NFKC").trim())
      .filter(Boolean)
    if (list.length < 1 || list.length > 3 || list.some((item) => item.length < 2 || item.length > 4)) {
      return { error: tr("settings.memory-keywords-error") }
    }
    const body = content().trim()
    if (!body || /[\r\n]/u.test(body)) return { error: tr("settings.memory-content-error") }
    if (props.entry?.scope === "experience") {
      return {
        value: {
          importance: value,
          keywords: list,
          content: body,
          kind: kind(),
          confidence: confidence(),
        },
      }
    }
    return { value: { importance: value, keywords: list, content: body } }
  })

  async function save() {
    if (!parsed().value) return
    setSaving(true)
    setFailure(undefined)
    try {
      await props.onSave(parsed().value!)
      props.onClose()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : tr("settings.memory-save-error"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      class="memory-editor"
      title={props.entry ? tr("settings.edit-memory") : tr("settings.add-user-memory")}
      description={tr("settings.memory-editor-description")}
      showClose
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" disabled={saving()} onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button
            disabled={!parsed().value}
            loading={saving()}
            loadingLabel={tr("settings.saving")}
            onClick={() => void save()}
          >
            {tr("github.save")}
          </Button>
        </>
      }
    >
      <div class="memory-editor__fields">
        <label>
          <span>{tr("settings.memory-importance")}</span>
          <input
            aria-label={tr("settings.memory-importance")}
            type="number"
            min="1"
            max="10"
            step="1"
            value={importance()}
            onInput={(event) => setImportance(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>{tr("settings.memory-keywords")}</span>
          <input
            aria-label={tr("settings.memory-keywords")}
            value={keywords()}
            onInput={(event) => setKeywords(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>{tr("settings.memory-content")}</span>
          <input
            aria-label={tr("settings.memory-content")}
            value={content()}
            onInput={(event) => setContent(event.currentTarget.value)}
          />
        </label>
        <Show when={props.entry?.scope === "experience"}>
          <label>
            <span>{tr("settings.experience-kind")}</span>
            <select
              aria-label={tr("settings.experience-kind")}
              value={kind()}
              onInput={(event) => setKind(event.currentTarget.value as "success" | "failure" | "lesson")}
            >
              <option value="success">{tr("settings.experience-kind-success")}</option>
              <option value="failure">{tr("settings.experience-kind-failure")}</option>
              <option value="lesson">{tr("settings.experience-kind-lesson")}</option>
            </select>
          </label>
          <label>
            <span>{tr("settings.experience-confidence")}</span>
            <select
              aria-label={tr("settings.experience-confidence")}
              value={confidence()}
              onInput={(event) => setConfidence(event.currentTarget.value as "low" | "medium" | "high")}
            >
              <option value="low">{tr("settings.experience-confidence-low")}</option>
              <option value="medium">{tr("settings.experience-confidence-medium")}</option>
              <option value="high">{tr("settings.experience-confidence-high")}</option>
            </select>
          </label>
          <label>
            <span>{tr("settings.experience-evidence")}</span>
            <input aria-label={tr("settings.experience-evidence")} value={props.entry?.scope === "experience" ? props.entry.evidence : ""} readOnly />
          </label>
        </Show>
      </div>
      <Show when={parsed().error}>{(message) => <p class="compaction-settings__validation">{message()}</p>}</Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
    </Dialog>
  )
}
