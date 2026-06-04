import { createStore, produce } from 'solid-js/store'
import type { Message, MessagePart, TaskPlan, TaskStep, FileChange } from '../types/models'

export interface SessionState {
  // Session metadata
  sessionId: string | null
  status: 'idle' | 'running' | 'error'

  // Messages
  messages: Message[]
  streamingMessageId: string | null   // currently streaming message

  // Task plan
  taskPlan: TaskPlan | null

  // File changes (code review)
  fileChanges: FileChange[]

  // UI state
  thinkingBlocksExpanded: boolean
  rightPanelExpanded: boolean
  rightPanelTab: 'tasks' | 'review'
  inputValue: string
  contextFiles: string[]              // attached file paths
}

const initialSessionState: SessionState = {
  sessionId: null,
  status: 'idle',
  messages: [],
  streamingMessageId: null,
  taskPlan: null,
  fileChanges: [],
  thinkingBlocksExpanded: true,
  rightPanelExpanded: false,
  rightPanelTab: 'tasks',
  inputValue: '',
  contextFiles: [],
}

const [sessionState, setSessionState] = createStore<SessionState>(initialSessionState)

export function useSessionStore() {
  return sessionState
}

export const sessionActions = {
  // === Session ===
  setSession(sessionId: string, status: 'idle' | 'running' | 'error' = 'idle') {
    setSessionState('sessionId', sessionId)
    setSessionState('status', status)
  },

  setSessionStatus(status: 'idle' | 'running' | 'error') {
    setSessionState('status', status)
  },

  resetSession() {
    setSessionState(initialSessionState)
  },

  // === Messages ===
  setMessages(messages: Message[]) {
    setSessionState('messages', messages)
  },

  addMessage(message: Message) {
    setSessionState('messages', produce((msgs) => {
      const idx = msgs.findIndex(m => m.id === message.id)
      if (idx >= 0) {
        msgs[idx] = message
      } else {
        msgs.push(message)
      }
    }))
  },

  updateMessage(messageId: string, updater: (message: Message | undefined) => Message | undefined) {
    setSessionState('messages', produce((msgs) => {
      const idx = msgs.findIndex(m => m.id === messageId)
      const current = idx >= 0 ? msgs[idx] : undefined
      const next = updater(current)
      if (!next) return
      if (idx >= 0) msgs[idx] = next
      else msgs.push(next)
    }))
  },

  updateMessagePart(messageId: string, part: MessagePart) {
    setSessionState('messages', (m) => m.id === messageId, 'parts', produce((parts) => {
      const idx = parts.findIndex(p => {
        if ('id' in p && 'id' in part && p.id && part.id) return p.id === part.id
        if (p.type === part.type) {
          // Match tool calls by toolName for running state updates
          if (p.type === 'tool_call' && part.type === 'tool_call') {
            return p.toolName === part.toolName
          }
          return false
        }
        return false
      })
      if (idx >= 0) {
        parts[idx] = part as any
      } else {
        parts.push(part as any)
      }
    }))
  },

  updatePermissionStatus(permissionId: string, status: 'approved' | 'denied') {
    setSessionState('messages', produce((msgs) => {
      for (const message of msgs) {
        for (const part of message.parts) {
          if (part.type === 'permission_request' && part.id === permissionId) {
            part.status = status
          }
        }
      }
    }))
  },

  setStreamingMessageId(id: string | null) {
    setSessionState('streamingMessageId', id)
  },

  appendStreamingText(text: string) {
    const msgId = sessionState.streamingMessageId
    if (!msgId) return
    setSessionState('messages', (m) => m.id === msgId, 'parts', produce((parts) => {
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.type === 'text') {
        lastPart.content += text
      } else {
        parts.push({ type: 'text', content: text })
      }
    }))
  },

  // === Task Plan ===
  setTaskPlan(plan: TaskPlan | null) {
    setSessionState('taskPlan', plan)
  },

  updateTaskStep(stepId: string, updates: Partial<TaskStep>) {
    setSessionState('taskPlan', 'steps', (s: TaskStep) => s.id === stepId, produce((step) => {
      Object.assign(step, updates)
    }))
  },

  setCurrentStepIndex(index: number) {
    setSessionState('taskPlan', 'currentStepIndex', index)
  },

  // === File Changes ===
  setFileChanges(changes: FileChange[]) {
    setSessionState('fileChanges', changes)
  },

  addFileChange(change: FileChange) {
    setSessionState('fileChanges', produce((changes) => {
      const idx = changes.findIndex(c => c.filePath === change.filePath)
      if (idx >= 0) {
        changes[idx] = change
      } else {
        changes.push(change)
      }
    }))
  },

  // === UI State ===
  setThinkingBlocksExpanded(expanded: boolean) {
    setSessionState('thinkingBlocksExpanded', expanded)
  },

  setRightPanelExpanded(expanded: boolean) {
    setSessionState('rightPanelExpanded', expanded)
  },

  toggleRightPanel() {
    setSessionState('rightPanelExpanded', (v) => !v)
  },

  setRightPanelTab(tab: 'tasks' | 'review') {
    setSessionState('rightPanelTab', tab)
  },

  setInputValue(value: string) {
    setSessionState('inputValue', value)
  },

  addContextFile(filePath: string) {
    setSessionState('contextFiles', produce((files) => {
      if (!files.includes(filePath)) files.push(filePath)
    }))
  },

  removeContextFile(filePath: string) {
    setSessionState('contextFiles', (files) => files.filter(f => f !== filePath))
  },

  clearContextFiles() {
    setSessionState('contextFiles', [])
  },
}
