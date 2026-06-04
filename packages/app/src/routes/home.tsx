import { createSignal, onMount, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAppState, appActions, startSidecar } from '../stores/app'
import { HeroSection } from '../components/home/HeroSection'
import { WorkspaceSelector } from '../components/home/WorkspaceSelector'
import { RecentProjects, type RecentProjectData } from '../components/home/RecentProjects'
import { SessionList } from '../components/home/SessionList'
import { EmailPanel } from '../components/home/EmailPanel'
import { CreateSessionFab } from '../components/home/CreateSessionFab'
import { Button } from '../components/ui/Button'
import { ApiClient } from '../api'
import type { Project, SessionInfo } from '../types/models'

export function HomePage() {
  const navigate = useNavigate()
  const state = useAppState()
  const [selectedProject, setSelectedProject] = createSignal<Project | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    if (!window.electron?.getStoreValue) return
    try {
      const recent = (await window.electron.getStoreValue('recentProjects')) as string[] | undefined
      if (!recent?.length) return

      appActions.setProjects(
        recent.map((dir, index) => ({
          id: dir || `recent-${index}`,
          name: dir.split(/[/\\]/).pop() || dir,
          directory: dir,
          lastOpened: Date.now(),
        })),
      )
    } catch {
      // Recent projects are optional.
    }
  })

  async function loadSessions(baseUrl: string, workspaceDir: string) {
    const client = new ApiClient(baseUrl, workspaceDir)
    appActions.setSessions(await client.sessions())
  }

  async function handleSelectWorkspace(dir: string) {
    setError(null)
    try {
      const result = await startSidecar(dir)
      if (!result?.baseUrl) throw new Error('Sidecar did not return a base URL')

      const project: Project = {
        id: dir,
        name: dir.split(/[/\\]/).pop() || dir,
        directory: dir,
        lastOpened: Date.now(),
      }

      appActions.addProject(project)
      appActions.setActiveProject(project.id)
      setSelectedProject(project)
      await loadSessions(result.baseUrl, dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start JYYCode service')
    }
  }

  function handleSelectProject(project: RecentProjectData) {
    handleSelectWorkspace(project.directory)
  }

  function handleCreateSession() {
    if (!state.baseUrl) return
    navigate('/session/new')
  }

  function handleSelectSession(session: SessionInfo) {
    navigate(`/session/${session.id}`)
  }

  return (
    <div class="home-screen">
      <div class="home-content">
        <HeroSection />
        <WorkspaceSelector onSelect={handleSelectWorkspace} loading={state.sidecarStatus === 'starting'} />

        <Show when={error() || state.sidecarStatus === 'error'}>
          <div class="app-error">{error() || 'JYYCode service failed to start.'}</div>
        </Show>

        <Show when={state.projects.length > 0 && !selectedProject()}>
          <section class="home-section">
            <div class="section-heading">
              <h2>Recent projects</h2>
            </div>
            <RecentProjects
              projects={state.projects.slice(0, 6).map((project) => ({
                name: project.name,
                directory: project.directory,
                lastOpened: project.lastOpened,
              }))}
              onSelect={handleSelectProject}
            />
          </section>
        </Show>

        <Show when={selectedProject() && state.baseUrl}>
          <section class="home-section">
            <div class="section-heading">
              <div>
                <span class="eyebrow">Active project</span>
                <h2>{selectedProject()?.name}</h2>
              </div>
              <Button variant="primary" onClick={handleCreateSession}>
                New task
              </Button>
            </div>
            <SessionList sessions={state.sessions} onSelect={handleSelectSession} onCreateNew={handleCreateSession} />
          </section>
        </Show>

        <Show when={state.sidecarStatus === 'running'}>
          <section class="home-section">
            <EmailPanel unreadCount={state.emailUnreadCount} onOpen={() => navigate('/email')} />
          </section>
        </Show>
      </div>

      <Show when={state.baseUrl}>
        <CreateSessionFab onClick={handleCreateSession} />
      </Show>
    </div>
  )
}
