import { useParams } from '@solidjs/router'
import { createEffect, onMount, onCleanup, createSignal } from 'solid-js'
import { appActions, useAppState } from '../stores/app'
import { useSessionStore, sessionActions } from '../stores/session'
import { useSSE } from '../hooks/useSSE'
import { Toolbar } from '../components/session/Toolbar'
import { MessageList } from '../components/session/MessageList'
import { InputArea } from '../components/session/InputArea'
import { RightPanel } from '../components/rightpanel/RightPanel'
import type { ModelInfo, PermissionRule, Message } from '../types/models'

// Default models for demo
const DEMO_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 128000, supportsReasoning: true, supportsTools: true },
  { id: 'claude-sonnet-4', name: 'Claude 4 Sonnet', provider: 'anthropic', maxTokens: 200000, supportsReasoning: true, supportsTools: true },
  { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek', maxTokens: 128000, supportsReasoning: true, supportsTools: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', maxTokens: 1000000, supportsReasoning: true, supportsTools: true },
]

export function SessionPage() {
  const params = useParams()
  const appState = useAppState()
  const session = useSessionStore()
  const { connected, connect, disconnect } = useSSE()

  // Local state for toolbar options
  const [selectedModel, setSelectedModel] = createSignal('gpt-4o')
  const [multiAgent, setMultiAgent] = createSignal(false)
  const [permissions, setPermissions] = createSignal<PermissionRule[]>([])
  const [thinkingDepth, setThinkingDepth] = createSignal(1) // 0-3

  // Initialize session on mount
  onMount(() => {
    const sessionId = params.id === 'new' ? null : params.id
    if (sessionId) {
      sessionActions.setSession(sessionId, 'idle')
      // Connect SSE for real-time events
      connect(sessionId)

      // Load messages from API (placeholder - would use SDK in production)
      loadMessages(sessionId)
    } else {
      // New session - create via API
      createNewSession()
    }
  })

  onCleanup(() => {
    disconnect()
  })

  async function createNewSession() {
    if (!appState.baseUrl) return
    try {
      const sdk = (await import('../hooks/useSDK')).useSDK()
      // In production, call SDK client to create session
      // const result = await client.session.create({ workspaceId: ..., title: '新会话' })
      const mockId = `session-${Date.now()}`
      sessionActions.setSession(mockId, 'idle')
      appActions.setActiveSession(mockId)
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }

  async function loadMessages(sessionId: string) {
    // Placeholder: load messages from API
    // In production, use SDK client
    console.log('Loading messages for session:', sessionId)
  }

  // Handle sending a message
  async function handleSend(text: string) {
    if (!session.sessionId || session.status === 'running') return

    // Add user message to local store
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      parts: [{ type: 'text', content: text }],
      timestamp: Date.now(),
    }
    sessionActions.addMessage(userMessage)
    sessionActions.setSessionStatus('running')

    // Send to backend via SDK
    try {
      // In production, stream response via SSE
      // For now, simulate a response
      const assistantMessage: Message = {
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        parts: [{
          type: 'text',
          content: `收到您的消息："${text}"。\n\n正在处理中...\n\n当前模型: ${selectedModel()}\n多Agent模式: ${multiAgent() ? '开启' : '关闭'}\n思考深度: ${['极少', '标准', '深度', '极限'][thinkingDepth()]}`,
        }],
        timestamp: Date.now(),
      }
      setTimeout(() => {
        sessionActions.addMessage(assistantMessage)
        sessionActions.setSessionStatus('idle')
      }, 1500)
    } catch (err) {
      console.error('Send failed:', err)
      sessionActions.setSessionStatus('error')
    }
  }

  function handleApprovePermission(messageId: string) {
    // Send approval to backend
    console.log('Approved permission for message:', messageId)
  }

  function handleDenyPermission(messageId: string) {
    console.log('Denied permission for message:', messageId)
  }

  function handleModelChange(modelId: string) {
    setSelectedModel(modelId)
  }

  function handleFileSelect(files: string[]) {
    files.forEach(f => sessionActions.addContextFile(f))
  }

  function handlePermissionChange(rules: PermissionRule[]) {
    setPermissions(rules)
  }

  return (
    <div style={{
      flex: '1',
      display: 'flex',
      'flex-direction': 'column',
      overflow: 'hidden',
      background: 'var(--color-white)',
    }}>
      {/* Toolbar */}
      <Toolbar
        model={selectedModel()}
        models={DEMO_MODELS}
        onModelChange={handleModelChange}
        multiAgent={multiAgent()}
        onMultiAgentChange={setMultiAgent}
        onFileSelect={handleFileSelect}
        permissions={permissions()}
        onPermissionChange={handlePermissionChange}
        thinkingDepth={thinkingDepth()}
        onThinkingDepthChange={setThinkingDepth}
        sessionTitle={`会话 · ${session.sessionId?.slice(-8) || '新建'}`}
      />

      {/* Main content area */}
      <div style={{
        flex: '1',
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Chat area */}
        <div style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          overflow: 'hidden',
        }}>
          {/* Messages */}
          <MessageList
            messages={session.messages}
            streamingMessageId={session.streamingMessageId}
            onApprovePermission={handleApprovePermission}
            onDenyPermission={handleDenyPermission}
          />

          {/* Input */}
          <InputArea
            onSend={handleSend}
            disabled={session.status === 'running'}
          />
        </div>

        {/* Right panel */}
        <RightPanel
          taskPlan={session.taskPlan}
          fileChanges={session.fileChanges}
        />
      </div>
    </div>
  )
}
