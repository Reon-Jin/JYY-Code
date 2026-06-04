import { createSignal, Show } from 'solid-js'
import { useSessionStore, sessionActions } from '../../stores/session'
import { ContextPills } from './ContextPills'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
}

export function InputArea(props: Props) {
  const session = useSessionStore()
  const [isComposing, setIsComposing] = createSignal(false)
  let textareaRef!: HTMLTextAreaElement

  function autoResize() {
    if (!textareaRef) return
    textareaRef.style.height = 'auto'
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, 180)}px`
  }

  function handleInput() {
    sessionActions.setInputValue(textareaRef.value)
    autoResize()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !isComposing()) {
      event.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    const text = session.inputValue.trim()
    if (!text || props.disabled) return

    props.onSend(text)
    sessionActions.setInputValue('')
    textareaRef.value = ''
    textareaRef.style.height = 'auto'
  }

  const canSend = () => Boolean(session.inputValue.trim()) && !props.disabled

  return (
    <div class="composer-wrap">
      <Show when={session.contextFiles.length > 0}>
        <ContextPills
          files={session.contextFiles}
          onRemove={(file) => sessionActions.removeContextFile(file)}
          onClear={() => sessionActions.clearContextFiles()}
        />
      </Show>

      <div class="composer">
        <textarea
          ref={textareaRef}
          value={session.inputValue}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="Write a message..."
          disabled={props.disabled}
          rows={1}
        />
        <button class="send-button" onClick={handleSend} disabled={!canSend()} title="Send">
          Send
        </button>
      </div>

      <div class="composer-footer">
        <span>
          {session.contextFiles.length > 0
            ? `${session.contextFiles.length} file${session.contextFiles.length > 1 ? 's' : ''} attached`
            : 'Enter to send, Shift+Enter for a new line'}
        </span>
        <Show when={session.status === 'running'}>
          <span class="live-indicator">Streaming response</span>
        </Show>
      </div>
    </div>
  )
}
