import type { Message } from '../../types/models'

interface Props {
  message: Message
}

export function UserMessage(props: Props) {
  // Extract text content from parts
  const textContent = () => {
    return props.message.parts
      .filter(p => p.type === 'text')
      .map(p => p.content)
      .join('\n')
  }

  return (
    <div style={{
      display: 'flex',
      'justify-content': 'flex-end',
    }}>
      <div style={{
        'max-width': '75%',
        background: 'var(--color-blue-apple)',
        color: 'var(--color-white)',
        'border-radius': 'var(--radius-feature) var(--radius-feature) 4px var(--radius-feature)',
        padding: 'var(--space-10) var(--space-14)',
      }}>
        <p class="text-body" style={{
          color: 'inherit',
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
        }}>
          {textContent()}
        </p>
      </div>
    </div>
  )
}
