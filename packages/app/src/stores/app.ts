import { createStore, produce } from 'solid-js/store'
import type { Project, SessionInfo } from '../types/models'

export interface AppState {
  // Theme
  theme: 'light' | 'dark' | 'system'

  // Projects
  projects: Project[]
  activeProjectId: string | null
  activeWorkspaceDir: string | null

  // Sessions
  sessions: SessionInfo[]
  activeSessionId: string | null

  // Email
  emailUnreadCount: number

  // Connection
  sidecarStatus: 'stopped' | 'starting' | 'running' | 'error'
  baseUrl: string | null   // jyycode server URL

  // UI state
  sidebarCollapsed: boolean
}

const initialState: AppState = {
  theme: 'system',
  projects: [],
  activeProjectId: null,
  activeWorkspaceDir: null,
  sessions: [],
  activeSessionId: null,
  emailUnreadCount: 0,
  sidecarStatus: 'stopped',
  baseUrl: null,
  sidebarCollapsed: false,
}

const [appState, setAppState] = createStore<AppState>(initialState)

// === Selectors ===
export function useAppState() {
  return appState
}

// === Actions ===
export const appActions = {
  setTheme(theme: 'light' | 'dark' | 'system') {
    setAppState('theme', theme)
  },

  setProjects(projects: Project[]) {
    setAppState('projects', projects)
  },

  setActiveProject(projectId: string | null) {
    setAppState('activeProjectId', projectId)
  },

  setActiveWorkspaceDir(directory: string | null) {
    setAppState('activeWorkspaceDir', directory)
  },

  addProject(project: Project) {
    setAppState('projects', produce((projects) => {
      const exists = projects.find(p => p.id === project.id)
      if (!exists) projects.push(project)
    }))
  },

  setSessions(sessions: SessionInfo[]) {
    setAppState('sessions', sessions)
  },

  setActiveSession(sessionId: string | null) {
    setAppState('activeSessionId', sessionId)
  },

  addSession(session: SessionInfo) {
    setAppState('sessions', produce((sessions) => {
      const idx = sessions.findIndex(s => s.id === session.id)
      if (idx >= 0) sessions[idx] = session
      else sessions.unshift(session)
    }))
  },

  updateSession(sessionId: string, updates: Partial<SessionInfo>) {
    setAppState('sessions', (s) => s.id === sessionId, produce((s) => Object.assign(s, updates)))
  },

  setEmailUnreadCount(count: number) {
    setAppState('emailUnreadCount', count)
  },

  setSidecarStatus(status: 'stopped' | 'starting' | 'running' | 'error') {
    setAppState('sidecarStatus', status)
  },

  setBaseUrl(url: string | null) {
    setAppState('baseUrl', url)
  },

  setSidebarCollapsed(collapsed: boolean) {
    setAppState('sidebarCollapsed', collapsed)
  },

  // Reset on project switch
  resetForNewProject() {
    setAppState('sessions', [])
    setAppState('activeSessionId', null)
  },
}

// === Sidecar integration ===
export async function startSidecar(workspaceDir: string) {
  appActions.setSidecarStatus('starting')
  try {
    if (!window.electron?.startSidecar) {
      const fallback = { port: 4096, baseUrl: 'http://127.0.0.1:4096' }
      appActions.setBaseUrl(fallback.baseUrl)
      appActions.setActiveWorkspaceDir(workspaceDir)
      appActions.setSidecarStatus('running')
      return fallback
    }
    const result = await window.electron?.startSidecar(workspaceDir)
    if (result) {
      appActions.setBaseUrl(result.baseUrl)
      appActions.setActiveWorkspaceDir(workspaceDir)
      appActions.setSidecarStatus('running')
      return result
    }
  } catch (err) {
    console.error('Failed to start sidecar:', err)
    appActions.setSidecarStatus('error')
    throw err
  }
}
