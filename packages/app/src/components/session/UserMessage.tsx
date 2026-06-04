import type { Message } from '../../types/models'

interface Props {
  message: Message
}

export function UserMessage(props: Props) {
  const textContent = () =>
    props.message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.content)
      .join('\n')

  return (
    <div class="message-row user-row">
      <div class="user-bubble">{textContent()}</div>
    </div>
  )
}
