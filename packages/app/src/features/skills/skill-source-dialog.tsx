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
    if (!source) return setError(type() === "path" ? "请输入本地路径" : "请输入 URL")
    setBusy(true)
    setError(undefined)
    try {
      await props.onAdd({ type: type(), value: source })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加 Skill 来源")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      class="skill-dialog"
      title="添加 Skill 来源"
      description="添加一个包含 Skill 的本地目录或远程 URL。"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button type="submit" form="skill-source-form" loading={busy()} loadingLabel="正在添加">
            添加
          </Button>
        </>
      }
    >
      <form id="skill-source-form" class="skill-form" onSubmit={submit}>
        <label>
          类型
          <select value={type()} onChange={(event) => setType(event.currentTarget.value as "path" | "url")}>
            <option value="path">本地路径</option>
            <option value="url">URL</option>
          </select>
        </label>
        <label>
          {type() === "path" ? "路径" : "URL"}
          <input autofocus value={value()} onInput={(event) => setValue(event.currentTarget.value)} />
        </label>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </form>
    </Dialog>
  )
}
