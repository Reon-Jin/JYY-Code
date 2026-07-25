import { tr } from "../../i18n/i18n-context"
import { MessageSquarePlus, Plus } from "lucide-solid"
import { createUniqueId, Show } from "solid-js"
import { Button } from "../../components/ui/button"

export function SessionEmpty(props: { archived?: boolean; onCreate: () => void; disabled?: boolean }) {
  const titleID = createUniqueId()
  return (
    <section class="session-empty" aria-labelledby={titleID}>
      <span class="session-empty__icon" aria-hidden="true">
        <MessageSquarePlus />
      </span>
      <h2 id={titleID}>
        {props.archived ? tr("sessions.no-archived-session-yet") : tr("sessions.start-a-new-conversation")}
      </h2>
      <p>
        {props.archived
          ? tr("sessions.archived-sessions-will-appear-here-for-easy-reference")
          : tr("sessions.create-a-single-agent-session-to-continue-working")}
      </p>
      <Show when={!props.archived}>
        <Button disabled={props.disabled} onClick={props.onCreate}>
          <Plus aria-hidden="true" />
          {tr("sessions.new-session")}
        </Button>
      </Show>
    </section>
  )
}
