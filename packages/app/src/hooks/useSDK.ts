import { createMemo } from 'solid-js'
import { useAppState } from '../stores/app'

// We'll create a simple typed client wrapper until the actual SDK is available
// The real @jyycode-ai/sdk has createJyycodeClient({ baseUrl })

export interface JyycodeClient {
  baseUrl: string
  // Session methods
  session: {
    create: (params: { workspaceId: string; title: string; model?: string; agent?: string }) => Promise<{ id: string }>
    list: (params: { projectId: string }) => Promise<any[]>
    get: (id: string) => Promise<any>
  }
  // Command
  command: {
    prompt: (params: { sessionId: string; input: any }) => AsyncIterable<any>
  }
  // Health
  health: () => Promise<{ status: string }>
}

// Create a mock/facade client (replace with real @jyycode-ai/sdk when ready)
function createClient(baseUrl: string): JyycodeClient {
  const fetchJson = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      ...init,
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }

  return {
    baseUrl,
    session: {
      create: (params) => fetchJson('/api/session', { method: 'POST', body: JSON.stringify(params) }),
      list: (params) => fetchJson(`/api/session?projectId=${params.projectId}`),
      get: (id) => fetchJson(`/api/session/${id}`),
    },
    command: {
      async *prompt(params) {
        // For SSE streaming, use EventSource
        const response = await fetch(`${baseUrl}/api/command/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        })
        const reader = response.body?.getReader()
        if (!reader) return
        // simplified SSE parsing - in production use proper SSE parser
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                yield JSON.parse(line.slice(6))
              } catch { /* ignore malformed JSON */ }
            }
          }
        }
      },
    },
    health: () => fetchJson('/health'),
  }
}

export function useSDK() {
  const state = useAppState()

  const client = createMemo(() => {
    const url = state.baseUrl
    if (!url) return null
    return createClient(url)
  })

  return client
}
