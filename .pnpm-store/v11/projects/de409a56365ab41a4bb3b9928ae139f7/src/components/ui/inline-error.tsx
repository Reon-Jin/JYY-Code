import { CircleAlert } from "lucide-solid"

export function InlineError(props: { message: string }) {
  return (
    <div class="ui-inline-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{props.message}</span>
    </div>
  )
}
