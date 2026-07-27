import { ShieldCheck, CircleHelp } from "lucide-solid"
import { createSignal, For } from "solid-js"
import type { PendingAction, RemoteTask } from "../lib/models"

export function PendingCard(props: { pending: PendingAction; task: RemoteTask; onApprove: (approved: boolean) => void; onAnswer: (answer: string) => void }) {
  const permission = () => props.pending.type === "permission"
  const [answer, setAnswer] = createSignal("")

  function submitAnswer() {
    const value = answer().trim()
    if (!value) return
    props.onAnswer(value)
    setAnswer("")
  }
  return (
    <section class="pending-card">
      <header>{permission() ? <ShieldCheck /> : <CircleHelp />}<span>{permission() ? "需要批准" : "需要回答"}</span></header>
      <strong>{props.pending.title}</strong>
      {props.pending.type === "permission" ? (
        <div class="button-row"><button class="primary-button" onClick={() => props.onApprove(true)}>批准</button><button class="secondary-button" onClick={() => props.onApprove(false)}>拒绝</button></div>
      ) : (
        <div class="answer-list">
          <For each={props.pending.options}>{(option) => <button class="secondary-button" onClick={() => props.onAnswer(option)}>{option}</button>}</For>
          <label class="pending-card__answer"><input placeholder="输入你的回答" value={answer()} onInput={(event) => setAnswer(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") submitAnswer() }} /><button class="secondary-button" disabled={!answer().trim()} onClick={submitAnswer}>发送回答</button></label>
        </div>
      )}
    </section>
  )
}
