import { createSignal, onCleanup } from 'solid-js'
import { useAppState, appActions } from '../stores/app'
import { useSessionStore, sessionActions } from '../stores/session'

/**
 * Subscribe to Server-Sent Events for real-time updates.
 * Connects to the jyycode server's event stream.
 */
export function useSSE() {
  const appState = useAppState()
  const [connected, setConnected] = createSignal(false)
  let eventSource: EventSource | null = null

  function connect(sessionId: string) {
    if (!appState.baseUrl) return

    // Disconnect previous
    disconnect()

    const url = `${appState.baseUrl}/api/event?sessionId=${sessionId}`
    eventSource = new EventSource(url)

    eventSource.onopen = () => {
      setConnected(true)
    }

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleEvent(data)
      } catch (err) {
        console.warn('SSE parse error:', err)
      }
    }

    // Handle specific event types
    eventSource.addEventListener('message.updated', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        sessionActions.addMessage(data.message)
      } catch {}
    })

    eventSource.addEventListener('message.part.updated', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        sessionActions.updateMessagePart(data.messageId, data.part)
      } catch {}
    })

    eventSource.addEventListener('session.status', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        appActions.updateSession(data.sessionId, { status: data.status })
        sessionActions.setSessionStatus(data.status)
      } catch {}
    })

    eventSource.addEventListener('task.plan', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        sessionActions.setTaskPlan(data.plan)
      } catch {}
    })

    eventSource.addEventListener('file.change', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        sessionActions.addFileChange(data.change)
      } catch {}
    })

    eventSource.onerror = () => {
      setConnected(false)
      // Auto-reconnect after 3s
      setTimeout(() => {
        if (eventSource?.readyState === EventSource.CLOSED) {
          connect(sessionId)
        }
      }, 3000)
    }
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    setConnected(false)
  }

  onCleanup(() => disconnect())

  return { connected, connect, disconnect }
}

// Event type router
function handleEvent(data: any) {
  // Route events to appropriate stores based on event type
  // This is a generic handler in addition to specific event listeners
}
