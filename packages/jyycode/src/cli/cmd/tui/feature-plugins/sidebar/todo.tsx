import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createSignal, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"

export function shouldShowTodoPanel(input: { todoCount: number; openTodoCount: number }) {
  return input.todoCount > 0 && input.openTodoCount > 0
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const show = createMemo(() => {
    return shouldShowTodoPanel({
      todoCount: list().length,
      openTodoCount: list().filter((item) => item.status !== "completed").length,
    })
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>Todo</b>
          </text>
        </box>

        <Show when={list().length > 2}>
          <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
            <text fg={theme().text}>{open() ? "v" : ">"}</text>
          </box>
        </Show>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
