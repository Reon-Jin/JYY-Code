import { MessageSquarePlus, Plus } from "lucide-solid"
import { createUniqueId } from "solid-js"
import { Button } from "../../components/ui/button"

export function SessionEmpty(props: { archived?: boolean; onCreate: () => void; disabled?: boolean }) {
  const titleID = createUniqueId()
  return (
    <section class="session-empty" aria-labelledby={titleID}>
      <span class="session-empty__icon" aria-hidden="true">
        <MessageSquarePlus />
      </span>
      <h2 id={titleID}>{props.archived ? "暂无归档 Session" : "开始一次新的对话"}</h2>
      <p>
        {props.archived
          ? "归档的 Session 会出现在这里，便于稍后查阅。"
          : "创建一个单 Agent Session，继续处理当前项目。"}
      </p>
      <Button disabled={props.disabled} onClick={props.onCreate}>
        <Plus aria-hidden="true" />
        新建 Session
      </Button>
    </section>
  )
}
