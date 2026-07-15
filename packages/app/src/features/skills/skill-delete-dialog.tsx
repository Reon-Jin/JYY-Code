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
      setError(cause instanceof Error ? cause.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      title={props.sourceRemoval ? "移除 Skill 来源" : "删除 Skill"}
      description={`${props.skill.name} · ${props.skill.location}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="danger" loading={busy()} loadingLabel="正在处理" onClick={() => void confirm()}>
            {props.sourceRemoval ? "确认移除" : "确认删除"}
          </Button>
        </>
      }
    >
      <p class="skill-dialog__warning">
        {props.sourceRemoval
          ? "将从全局配置中移除此来源，缓存内容不会被直接编辑。"
          : "该操作会删除显示位置中的 Skill。"}
      </p>
      <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
    </Dialog>
  )
}
