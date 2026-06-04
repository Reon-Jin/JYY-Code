import { createSignal, Show } from 'solid-js'
import { useSessionStore, sessionActions } from '../../stores/session'
import { ContextPills } from './ContextPills'
import { Button } from '../ui/Button'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
}

export function InputArea(props: Props) {
  const session = useSessionStore()
  const [isComposing, setIsComposing] = createSignal(false)
  let textareaRef!: HTMLTextAreaElement

  // Auto-resize textarea
  function autoResize() {
    const el = textareaRef
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  function handleInput() {
    sessionActions.setInputValue(textareaRef.value)
    autoResize()
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey && !isComposing()) {
      e.preventDefault()
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

  return (
    <div style={{
      'border-top': '1px solid rgba(0,0,0,0.06)',
      'flex-shrink': '0',
    }}>
      {/* Context pills */}
      <Show when={session.contextFiles.length > 0}>
        <div style={{
          padding: 'var(--space-8) var(--space-14) 0',
        }}>
          <ContextPills
            files={session.contextFiles}
            onRemove={(file) => sessionActions.removeContextFile(file)}
            onClear={() => sessionActions.clearContextFiles()}
          />
        </div>
      </Show>

      {/* Input row */}
      <div style={{
        display: 'flex',
        'align-items': 'flex-end',
        gap: 'var(--space-10)',
        padding: 'var(--space-10) var(--space-14)',
        background: 'var(--color-white)',
      }}>
        {/* Textarea */}
        <div style={{
          flex: '1',
          position: 'relative',
        }}>
          <textarea
            ref={textareaRef}
            value={session.inputValue}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            disabled={props.disabled}
            rows={1}
            style={{
              width: '100%',
              background: 'var(--color-filter-bg)',
              border: '3px solid rgba(0,0,0,0.04)',
              'border-radius': 'var(--radius-search)',
              padding: 'var(--space-8) var(--space-14)',
              'font-family': 'var(--font-text)',
              'font-size': '17px',
              'line-height': '1.47',
              'letter-spacing': '-0.374px',
              color: 'var(--color-text-primary)',
              resize: 'none',
              outline: 'none',
              'min-height': '40px',
              'max-height': '200px',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-blue-apple)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(0,0,0,0.04)'
            }}
          />
        </div>

        {/* Send button */}
        <Button
          variant="primary"
          size="md"
          onClick={handleSend}
          disabled={props.disabled || !session.inputValue.trim()}
          style={{
            'flex-shrink': '0',
            'min-width': '60px',
            height: '40px',
            opacity: props.disabled || !session.inputValue.trim() ? 0.5 : 1,
            transition: 'opacity 0.2s',
          } as any}
        >
          发送
        </Button>
      </div>

      {/* Footer hint */}
      <div style={{
        padding: '0 var(--space-14) var(--space-4)',
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
      }}>
        <span class="text-micro" style={{ color: 'var(--color-text-tertiary)' }}>
          {session.contextFiles.length > 0
            ? `已附加 ${session.contextFiles.length} 个文件`
            : '输入您的问题'}
        </span>
        {session.status === 'running' && (
          <span class="text-micro" style={{ color: 'var(--color-blue-apple)' }}>
            ● AI 正在思考...
          </span>
        )}
      </div>

      {/* Pulse animation style */}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  )
}
