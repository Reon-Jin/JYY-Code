import { createSignal, onMount, For, Show } from 'solid-js'
import { useEmailStore, emailActions } from '../stores/email'
import { EmailItem } from '../components/email/EmailItem'
import { EmailDetail } from '../components/email/EmailDetail'
import type { Email } from '../types/models'

export function EmailPage() {
  const state = useEmailStore()
  const [replying, setReplying] = createSignal(false)

  const selectedEmail = () =>
    state.emails.find(e => e.id === state.selectedEmailId) || null

  function handleSelectEmail(email: Email) {
    emailActions.setSelectedEmail(email.id)
    if (!email.read) {
      emailActions.markAsRead(email.id)
    }
  }

  async function handleSendReply(text: string) {
    const email = selectedEmail()
    if (!email) return
    // TODO: Send reply via API
    console.log('Reply to:', email.id, text)
    setReplying(false)
  }

  return (
    <div style={{
      flex: '1',
      display: 'flex',
      overflow: 'hidden',
    }}>
      {/* Left sidebar: email list */}
      <div style={{
        width: '300px',
        'min-width': '280px',
        'border-right': '1px solid rgba(0,0,0,0.06)',
        display: 'flex',
        'flex-direction': 'column',
        background: 'var(--color-gray-light)',
      }}>
        {/* Header */}
        <div style={{
          padding: 'var(--space-14) var(--space-14) var(--space-10)',
          'border-bottom': '1px solid rgba(0,0,0,0.06)',
        }}>
          <h2 class="text-card-title-bold" style={{ 'margin-bottom': '4px' }}>
            📬 收件箱
          </h2>
          <p class="text-caption" style={{ color: 'var(--color-text-tertiary)' }}>
            {state.emails.length} 封邮件
            {state.emails.filter(e => !e.read).length > 0 &&
              ` · ${state.emails.filter(e => !e.read).length} 封未读`}
          </p>
        </div>

        {/* Email list */}
        <div style={{
          flex: '1',
          overflow: 'auto',
        }}>
          <Show when={state.emails.length > 0} fallback={
            <div style={{
              'text-align': 'center',
              padding: '48px 16px',
              color: 'var(--color-text-tertiary)',
            }}>
              <p style={{ 'font-size': '28px', 'margin-bottom': '8px' }}>📭</p>
              <p class="text-caption">暂无邮件</p>
              <p class="text-micro" style={{ 'margin-top': '8px' }}>
                用户通过邮件发送的任务将显示在此
              </p>
            </div>
          }>
            <For each={state.emails}>
              {(email) => (
                <EmailItem
                  email={email}
                  selected={email.id === state.selectedEmailId}
                  onClick={() => handleSelectEmail(email)}
                />
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Right: email detail / reply */}
      <div style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}>
        <Show when={selectedEmail()} fallback={
          <div style={{
            flex: '1',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            color: 'var(--color-text-tertiary)',
          }}>
            <div style={{ 'text-align': 'center' }}>
              <p style={{ 'font-size': '32px', 'margin-bottom': '12px' }}>📧</p>
              <p class="text-body">选择一封邮件查看详情</p>
            </div>
          </div>
        }>
          <EmailDetail
            email={selectedEmail()!}
            onReply={(text) => handleSendReply(text)}
          />
        </Show>
      </div>
    </div>
  )
}
