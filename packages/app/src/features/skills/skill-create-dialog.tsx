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
    if (!skillName) return setError("请输入 Skill 名称")
    if (!skillDescription) return setError("请输入 Skill 描述")
    const safeDescription = skillDescription.replace(/[\r\n]+/g, " ")
    const content = `---\nname: ${skillName}\ndescription: ${safeDescription}\n---\n\n${body()}`
    setBusy(true)
    setError(undefined)
    try {
      await props.onCreate({ name: skillName, description: safeDescription, content })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建 Skill")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      class="skill-dialog"
      title="新建 Skill"
      description="创建一个保存在全局配置目录中的 SKILL.md。"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button type="submit" form="skill-create-form" loading={busy()} loadingLabel="正在创建">
            创建
          </Button>
        </>
      }
    >
      <form id="skill-create-form" class="skill-form" onSubmit={submit}>
        <label>
          名称
          <input autofocus value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label>
          描述
          <input value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        </label>
        <label>
          正文
          <textarea rows={8} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
      </form>
    </Dialog>
  )
}
