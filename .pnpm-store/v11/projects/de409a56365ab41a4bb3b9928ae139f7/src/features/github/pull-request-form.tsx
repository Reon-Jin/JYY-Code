import { createEffect, createSignal, on, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"

export type PullRequestFormValue = { title: string; body: string; head: string; base: string; draft?: boolean }

export function PullRequestForm(props: {
  mode: "create" | "edit"
  initial?: PullRequestFormValue
  onSubmit: (value: PullRequestFormValue) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [head, setHead] = createSignal("")
  const [base, setBase] = createSignal("main")
  const [draft, setDraft] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()

  createEffect(
    on(
      () => props.initial,
      (value) => {
        setTitle(value?.title ?? "")
        setBody(value?.body ?? "")
        setHead(value?.head ?? "")
        setBase(value?.base ?? "main")
        setDraft(value?.draft ?? false)
      },
      { defer: false },
    ),
  )

  async function submit() {
    const value = { title: title().trim(), body: body(), head: head().trim(), base: base().trim(), draft: draft() }
    if (!value.title || (props.mode === "create" && (!value.head || !value.base))) {
      setError(props.mode === "create" ? "标题、Head 和 Base 均为必填项" : "标题不能为空")
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await props.onSubmit(value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pull Request 保存失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      class="pull-form"
      aria-label={props.mode === "create" ? "创建 Pull Request" : "编辑 Pull Request"}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h3>{props.mode === "create" ? "创建 Pull Request" : "编辑 Pull Request"}</h3>
      <label>
        <span>标题</span>
        <input value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
      </label>
      <Show when={props.mode === "create"}>
        <div class="pull-form__branches">
          <label>
            <span>Head</span>
            <input value={head()} onInput={(event) => setHead(event.currentTarget.value)} />
          </label>
          <label>
            <span>Base</span>
            <input value={base()} onInput={(event) => setBase(event.currentTarget.value)} />
          </label>
        </div>
        <label class="pull-form__checkbox">
          <input type="checkbox" checked={draft()} onChange={(event) => setDraft(event.currentTarget.checked)} />
          <span>创建为 Draft</span>
        </label>
      </Show>
      <label>
        <span>正文</span>
        <textarea rows={8} value={body()} onInput={(event) => setBody(event.currentTarget.value)} />
      </label>
      <Show when={error()}>
        <InlineError message={error()!} />
      </Show>
      <div class="pull-form__actions">
        <Button variant="ghost" onClick={props.onCancel}>
          取消
        </Button>
        <Button type="submit" loading={pending()}>
          {props.mode === "create" ? "创建" : "保存"}
        </Button>
      </div>
    </form>
  )
}
