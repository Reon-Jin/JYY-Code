import type { Part } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useData } from "../../data/context"
import { ActivityGroup } from "./activity-group"
import { conversationQueryOptions } from "./conversation-query"
import type { ConversationMessage } from "./conversation-state"
import { MessagePartView } from "./message-part"

function taskActivityParts(messages: readonly ConversationMessage[]) {
  return messages.flatMap((message) =>
    message.info.role === "assistant"
      ? message.parts.filter((part) => part.type === "reasoning" || part.type === "tool")
      : [],
  ) as Part[]
}

export function TaskActivityContent(props: { messages: readonly ConversationMessage[]; running?: boolean }) {
  const parts = createMemo(() => taskActivityParts(props.messages))

  return (
    <Show when={parts().length > 0 || props.running}>
      <ActivityGroup
        class="tool-call__activity"
        label="Task 执行过程"
        count={parts().length}
        running={props.running}
        defaultExpanded
      >
        <Show when={parts().length > 0} fallback={<span class="task-activity__waiting">等待子任务输出…</span>}>
          <For each={parts()}>{(part) => <MessagePartView part={part} />}</For>
        </Show>
      </ActivityGroup>
    </Show>
  )
}

export function TaskActivity(props: { sessionID: string; running?: boolean }) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...conversationQueryOptions({
        client: data.client(),
        directory: data.directory(),
        sessionID: props.sessionID,
        queryClient: data.queryClient(),
      }),
      enabled: Boolean(props.sessionID),
    }),
    data.queryClient,
  )

  return <TaskActivityContent messages={query.data?.messages ?? []} running={props.running} />
}
