import { createSignal, onMount, For, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAppState, appActions, startSidecar } from '../stores/app'
import { HeroSection } from '../components/home/HeroSection'
import { WorkspaceSelector } from '../components/home/WorkspaceSelector'
import { RecentProjects, type RecentProjectData } from '../components/home/RecentProjects'
import { SessionList } from '../components/home/SessionList'
import { EmailPanel } from '../components/home/EmailPanel'
import { CreateSessionFab } from '../components/home/CreateSessionFab'
import { Button } from '../components/ui/Button'
import type { Project, SessionInfo } from '../types/models'

export function HomePage() {
  const navigate = useNavigate()
  const state = useAppState()
  const [selectedProject, setSelectedProject] = createSignal<Project | null>(null)

  // Load recent projects from electron store on mount
  onMount(async () => {
    if (window.electron?.getStoreValue) {
      try {
        const recent = await window.electron.getStoreValue('recentProjects') as string[] | undefined
        if (recent && recent.length > 0) {
          const projects: Project[] = recent.map((dir, i) => ({
            id: `recent-${i}`,
            name: dir.split(/[/\\]/).pop() || dir,
            directory: dir,
            lastOpened: Date.now(),
          }))
          appActions.setProjects(projects)
        }
      } catch {}
    }
  })

  async function handleSelectWorkspace(dir: string) {
    // Start sidecar for this workspace
    try {
      await startSidecar(dir)
      // Create project entry
      const project: Project = {
        id: dir,
        name: dir.split(/[/\\]/).pop() || dir,
        directory: dir,
        lastOpened: Date.now(),
      }
      appActions.addProject(project)
      setSelectedProject(project)
    } catch (err) {
      console.error('Failed to start sidecar:', err)
    }
  }

  function handleSelectProject(project: RecentProjectData) {
    handleSelectWorkspace(project.directory)
  }

  function handleCreateSession() {
    if (!state.baseUrl) return
    // Navigate to new session (placeholder: create via API then navigate)
    navigate('/session/new')
  }

  function handleSelectSession(session: SessionInfo) {
    navigate(`/session/${session.id}`)
  }

  function handleOpenEmail() {
    navigate('/email')
  }

  return (
    <div style={{
      flex: '1',
      overflow: 'auto',
      background: 'var(--color-gray-light)',
    }}>
      <div style={{
        'max-width': '980px',
        margin: '0 auto',
        padding: '64px 32px',
      }}>
        {/* Hero Section */}
        <HeroSection />

        {/* Workspace Selector */}
        <section style={{
          padding: '48px 0',
          'border-bottom': '1px solid rgba(0,0,0,0.06)',
        }}>
          <WorkspaceSelector onSelect={handleSelectWorkspace} loading={state.sidecarStatus === 'starting'} />
        </section>

        {/* Status indicator */}
        <Show when={state.sidecarStatus === 'starting'}>
          <div style={{
            'text-align': 'center',
            padding: '16px',
            color: 'var(--color-text-secondary)',
            'font-size': '14px',
          }}>
            正在启动 JYYCode 服务...
          </div>
        </Show>

        <Show when={state.sidecarStatus === 'error'}>
          <div style={{
            'text-align': 'center',
            padding: '16px',
            color: '#ff3b30',
            'font-size': '14px',
          }}>
            服务启动失败，请重试
          </div>
        </Show>

        {/* Recent Projects Grid */}
        <Show when={state.projects.length > 0 && !selectedProject()}>
          <section style={{ padding: '48px 0' }}>
            <h2 class="text-section-heading" style={{ 'margin-bottom': '24px' }}>
              最近项目
            </h2>
            <RecentProjects projects={state.projects.slice(0, 6).map(p => ({
              name: p.name,
              directory: p.directory,
              lastOpened: p.lastOpened,
            }))} onSelect={handleSelectProject} />
          </section>
        </Show>

        {/* Sessions for active project */}
        <Show when={selectedProject() && state.baseUrl}>
          <section style={{ padding: '32px 0' }}>
            <div style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              'margin-bottom': '24px',
            }}>
              <h2 class="text-section-heading" style={{ 'margin-bottom': '0' }}>
                {selectedProject()?.name} · 会话
              </h2>
              <Button variant="primary" pill onClick={handleCreateSession}>
                新建会话
              </Button>
            </div>
            <SessionList
              sessions={state.sessions}
              onSelect={handleSelectSession}
              onCreateNew={handleCreateSession}
            />
          </section>
        </Show>

        {/* Email Panel */}
        <Show when={state.sidecarStatus === 'running'}>
          <section style={{ padding: '32px 0' }}>
            <EmailPanel
              unreadCount={state.emailUnreadCount}
              onOpen={handleOpenEmail}
            />
          </section>
        </Show>
      </div>

      {/* Floating Action Button for quick new session */}
      <Show when={state.baseUrl}>
        <CreateSessionFab onClick={handleCreateSession} />
      </Show>
    </div>
  )
}
