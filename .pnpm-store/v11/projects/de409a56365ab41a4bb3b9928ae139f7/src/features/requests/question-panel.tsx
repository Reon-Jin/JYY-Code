import type { QuestionRequest } from "@jyycode-ai/sdk/v2/client"
import { CircleHelp } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./requests.css"

export type QuestionPanelProps = {
  client: Pick<DesktopClient, "question">
  directory: string
  request: QuestionRequest
}

export function QuestionPanel(props: QuestionPanelProps) {
  const [active, setActive] = createSignal(0)
  const [selected, setSelected] = createSignal<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.request.questions.map(() => ""))
  const [submitting, setSubmitting] = createSignal(false)
  const [submitted, setSubmitted] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const disabled = () => submitting() || submitted()
  let panel: HTMLElement | undefined

  const answers = createMemo(() =>
    props.request.questions.map((_, index) => {
      const value = custom()[index]?.trim()
      return value ? [...(selected()[index] ?? []), value] : [...(selected()[index] ?? [])]
    }),
  )
  const complete = createMemo(() => answers().every((answer) => answer.length > 0))

  function choose(questionIndex: number, label: string, multiple: boolean, checked: boolean) {
    setSelected((current) => {
      const next = current.map((answer) => [...answer])
      next[questionIndex] = multiple
        ? checked
          ? [...(next[questionIndex] ?? []), label]
          : (next[questionIndex] ?? []).filter((value) => value !== label)
        : [label]
      return next
    })
    if (!multiple) {
      setCustom((current) => current.map((value, index) => (index === questionIndex ? "" : value)))
    }
  }

  function setCustomAnswer(questionIndex: number, value: string, multiple: boolean) {
    setCustom((current) => current.map((answer, index) => (index === questionIndex ? value : answer)))
    if (!multiple && value) {
      setSelected((current) => current.map((answer, index) => (index === questionIndex ? [] : answer)))
    }
  }

  async function submit() {
    if (disabled() || !complete()) return
    setSubmitting(true)
    setFailure(undefined)
    try {
      await props.client.question.reply(
        { directory: props.directory, requestID: props.request.id, answers: answers() },
        { throwOnError: true },
      )
      setSubmitted(true)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setSubmitting(false)
    }
  }

  async function reject() {
    if (disabled()) return
    setSubmitting(true)
    setFailure(undefined)
    try {
      await props.client.question.reject(
        { directory: props.directory, requestID: props.request.id },
        { throwOnError: true },
      )
      setSubmitted(true)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setSubmitting(false)
    }
  }

  function focusFirstControl() {
    panel?.querySelector<HTMLElement>('input:not(:disabled), button[role="tab"]:not(:disabled)')?.focus()
  }

  return (
    <section
      ref={(element) => {
        panel = element
      }}
      class="request-panel"
      aria-label="Agent 提问"
      role="region"
    >
      <p class="request-panel__announcement" role="status" aria-live="polite">
        Agent 发来了新的问题
      </p>
      <header class="request-panel__header">
        <span class="request-panel__icon" aria-hidden="true">
          <CircleHelp />
        </span>
        <span class="request-panel__heading">
          <strong>Agent 提问</strong>
          <small>{props.request.questions.length} 个问题</small>
        </span>
        <Button size="small" variant="ghost" disabled={disabled()} onClick={focusFirstControl}>
          处理请求
        </Button>
      </header>

      <div class="request-panel__body">
        <Show when={props.request.questions.length > 1}>
          <div class="question-tabs" role="tablist" aria-label="问题列表">
            <For each={props.request.questions}>
              {(question, index) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active() === index()}
                  aria-controls={`question-${props.request.id}-${index()}`}
                  disabled={disabled()}
                  onClick={() => setActive(index())}
                >
                  {question.header}
                </button>
              )}
            </For>
          </div>
        </Show>

        <For each={props.request.questions}>
          {(question, questionIndex) => (
            <section
              id={`question-${props.request.id}-${questionIndex()}`}
              class="question-page"
              role="tabpanel"
              hidden={active() !== questionIndex()}
            >
              <h3>{question.header}</h3>
              <p>{question.question}</p>
              <div class="question-options">
                <For each={question.options}>
                  {(option, optionIndex) => {
                    const id = `question-${props.request.id}-${questionIndex()}-${optionIndex()}`
                    return (
                      <label for={id} class="question-option">
                        <input
                          id={id}
                          type={question.multiple ? "checkbox" : "radio"}
                          name={`question-${props.request.id}-${questionIndex()}`}
                          value={option.label}
                          checked={(selected()[questionIndex()] ?? []).includes(option.label)}
                          disabled={disabled()}
                          onChange={(event) =>
                            choose(questionIndex(), option.label, question.multiple === true, event.currentTarget.checked)
                          }
                        />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      </label>
                    )
                  }}
                </For>
              </div>
              <Show when={question.custom}>
                <label class="request-panel__field">
                  <span>自定义回答</span>
                  <input
                    type="text"
                    value={custom()[questionIndex()] ?? ""}
                    disabled={disabled()}
                    onInput={(event) =>
                      setCustomAnswer(questionIndex(), event.currentTarget.value, question.multiple === true)
                    }
                  />
                </label>
              </Show>
            </section>
          )}
        </For>

        <div class="request-panel__actions">
          <Button
            size="small"
            disabled={disabled() || !complete()}
            loading={submitting()}
            loadingLabel="正在提交"
            onClick={() => void submit()}
          >
            提交回答
          </Button>
          <Button size="small" variant="ghost" disabled={disabled()} onClick={() => void reject()}>
            拒绝问题
          </Button>
        </div>
        <Show when={failure()}>{(cause) => <InlineError message={errorMessage(cause(), "问题回复失败")} />}</Show>
        <p class="request-panel__status" role="status" aria-label="问题请求状态" aria-live="polite">
          {submitted() ? "已提交，等待服务端确认" : ""}
        </p>
      </div>
    </section>
  )
}
