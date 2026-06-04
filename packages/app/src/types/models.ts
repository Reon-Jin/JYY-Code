// ==================== Project ====================
export interface Project {
  id: string
  name: string
  directory: string            // workspace absolute path
  vcs?: 'git' | null
  lastOpened: number           // timestamp
  icon?: string
}

// ==================== Session ====================
export interface SessionInfo {
  id: string
  title: string
  projectId: string
  model: string
  agent: string
  status: 'idle' | 'running' | 'error'
  createdAt: number
  updatedAt: number
  messageCount: number
}

// ==================== Message ====================
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  timestamp: number
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | PermissionRequestPart

export interface TextPart {
  id?: string
  type: 'text'
  content: string    // markdown string
}

export interface ReasoningPart {
  id?: string
  type: 'reasoning'
  content: string
  collapsed: boolean    // UI state: is the reasoning block collapsed?
}

export interface ToolCallPart {
  id?: string
  type: 'tool_call'
  toolName: 'read' | 'write' | 'shell' | 'grep' | 'glob' | 'edit' | 'apply_patch' | 'web_fetch' | 'web_search' | 'task' | 'question' | 'skill'
  toolInput: Record<string, unknown>
  toolOutput?: string
  status: 'pending' | 'running' | 'completed' | 'error'
  elapsed?: number       // execution time in seconds
}

export interface PermissionRequestPart {
  id?: string
  type: 'permission_request'
  toolName: string
  message: string        // human-readable request message
  status: 'pending' | 'approved' | 'denied'
}

// ==================== Task Plan ====================
export interface TaskPlan {
  steps: TaskStep[]
  currentStepIndex: number
  totalSteps: number
  estimatedTime?: number     // seconds
}

export interface TaskStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  elapsed?: number           // seconds
  detail?: string            // detailed description
}

// ==================== File Changes / Diff ====================
export interface FileChange {
  filePath: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  hunks: DiffHunk[]
  patch?: string
}

export interface DiffHunk {
  header: string          // @@ -1,5 +1,7 @@
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'context' | 'addition' | 'deletion'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

// ==================== Email ====================
export interface Email {
  id: string
  from: string
  to: string
  subject: string
  body: string
  timestamp: number
  read: boolean
  sessionId?: string      // linked JYYCode session
}

// ==================== Model ====================
export interface ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  provider: string
  maxTokens: number
  supportsReasoning: boolean
  supportsTools: boolean
  connected?: boolean
}

// ==================== Permission ====================
export interface PermissionRule {
  toolName: string
  policy: 'allow' | 'deny' | 'ask'
}
