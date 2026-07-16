import { tr } from "../../i18n/i18n-context"
import type { Todo } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { CheckCircle2, Circle, CircleDot, CircleX, ListTodo, RefreshCw } from "lucide-solid"
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { todoQueryOptions } from "./todo-query"
import "./todo-panel.css"

export type TodoPanelViewProps = {
  directory: string
  sessionID?: string
  todos?: readonly Todo[]
  loading?: boolean
  error?: string
  collapsed?: boolean
  onRetry?: () => void
}

type TodoState = "pending" | "in_progress" | "completed" | "cancelled"

function todoState(status: string): TodoState {
  if (status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled") {
    return status
  }
  return "cancelled"
}

function stateLabel(state: TodoState) {
  switch (state) {
    case "pending":
      return tr("todos.not-started")
    case "in_progress":
      return tr("todos.in-progress")
    case "completed":
      return tr("conversation.completed")
    case "cancelled":
      return tr("multi-agent.canceled")
  }
}

function StateIcon(props: { state: TodoState }): JSX.Element {
  return (
    <Switch>
      <Match when={props.state === "pending"}>
        <Circle aria-hidden="true" />
      </Match>
      <Match when={props.state === "in_progress"}>
        <CircleDot aria-hidden="true" />
      </Match>
      <Match when={props.state === "completed"}>
        <CheckCircle2 aria-hidden="true" />
      </Match>
      <Match when={props.state === "cancelled"}>
        <CircleX aria-hidden="true" />
      </Match>
    </Switch>
  )
}

export function TodoPanelView(props: TodoPanelViewProps) {
  const todos = () => props.todos ?? []

  return (
    <section class="todo-panel" data-collapsed={props.collapsed ? "true" : "false"} aria-labelledby="todo-panel-title">
      <header class="todo-panel__header">
        <ListTodo aria-hidden="true" />
        <h2 id="todo-panel-title">{tr("todos.plan")}</h2>
        <Show when={props.sessionID && !props.loading && !props.error}>
          <span class="todo-panel__count" aria-label={tr("todos.step-count", { count: todos().length })}>
            {todos().length}
          </span>
        </Show>
      </header>

      <Show when={!props.collapsed}>
        <div class="todo-panel__body">
          <Show when={props.sessionID} fallback={<p class="todo-panel__empty">{tr("todos.show-steps-after-creating-or-selecting-a-session")}</p>}>
            <Show
              when={!props.loading}
              fallback={
                <p class="todo-panel__loading" role="status" aria-live="polite">
                  <Spinner /> {tr("todos.loading-steps")}
                </p>
              }
            >
              <Show
                when={!props.error}
                fallback={
                  <div class="todo-panel__error">
                    <InlineError message={props.error!} />
                    <Show when={props.onRetry}>
                      <Button size="small" variant="secondary" onClick={props.onRetry}>
                        <RefreshCw aria-hidden="true" />
                        {tr("changes.try-again")}
                      </Button>
                    </Show>
                  </div>
                }
              >
                <Show when={todos().length > 0} fallback={<p class="todo-panel__empty">{tr("todos.there-are-no-steps-in-the-current-session")}</p>}>
                  <ol class="todo-panel__list">
                    <For each={todos()}>
                      {(todo) => {
                        const state = () => todoState(todo.status)
                        return (
                          <li
                            class={`todo-panel__item todo-panel__item--${state()}`}
                            aria-current={state() === "in_progress" ? "step" : undefined}
                          >
                            <span class="todo-panel__state-icon" data-state={state()}>
                              <StateIcon state={state()} />
                            </span>
                            <span class="todo-panel__content">{todo.content}</span>
                            <span class="todo-panel__state-label">{stateLabel(state())}</span>
                          </li>
                        )
                      }}
                    </For>
                  </ol>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : tr("todos.unable-to-load-steps")
}

export function TodoPanel(props: { directory: string; sessionID?: string; collapsed?: boolean }) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...todoQueryOptions({
        client: data.client(),
        directory: props.directory,
        sessionID: props.sessionID ?? "",
      }),
      enabled: Boolean(props.sessionID),
    }),
    data.queryClient,
  )

  return (
    <TodoPanelView
      directory={props.directory}
      sessionID={props.sessionID}
      todos={query.data}
      loading={Boolean(props.sessionID) && query.isPending}
      error={query.error ? errorMessage(query.error) : undefined}
      collapsed={props.collapsed}
      onRetry={() => void query.refetch()}
    />
  )
}
