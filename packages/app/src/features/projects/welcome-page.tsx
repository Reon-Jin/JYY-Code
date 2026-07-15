import { useNavigate } from "@solidjs/router"
import { FolderOpen, Plus } from "lucide-solid"
import { createSignal, onMount, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "./project-controller"
import { ProjectCreateDialog } from "./project-create-dialog"
import { useProjects } from "./project-context"
import { RecentProjects } from "./recent-projects"
import "./projects.css"

export function WelcomePage() {
  const projects = useProjects()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  onMount(() => {
    projects.loadRecentProjects().catch((cause) => setError(errorMessage(cause, "无法读取最近项目")))
  })

  async function openSelectedProject() {
    setBusy(true)
    setError(undefined)
    try {
      await projects.chooseAndOpenProject()
    } catch (cause) {
      setError(errorMessage(cause, "无法打开项目"))
    } finally {
      setBusy(false)
    }
  }

  async function openRecentProject(path: string) {
    setBusy(true)
    setError(undefined)
    try {
      await projects.openProject(path)
    } catch (cause) {
      setError(errorMessage(cause, "无法打开项目"))
    } finally {
      setBusy(false)
    }
  }

  async function removeRecentProject(path: string) {
    setError(undefined)
    try {
      await projects.removeRecentProject(path)
    } catch (cause) {
      setError(errorMessage(cause, "无法移除最近项目"))
    }
  }

  return (
    <main class="welcome-page">
      <div class="welcome-layout">
        <section class="welcome-intro" aria-labelledby="welcome-title">
          <h1 id="welcome-title">JYYCode</h1>

          <div class="welcome-actions" aria-label="项目操作">
            <Button class="welcome-action" loading={busy()} loadingLabel="正在打开" onClick={openSelectedProject}>
              <FolderOpen aria-hidden="true" />
              <strong>打开目录</strong>
            </Button>
            <Button class="welcome-action" disabled={busy()} onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              <strong>新建项目</strong>
            </Button>
          </div>

          <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
        </section>

        <RecentProjects
          projects={projects.recentProjects()}
          isUnavailable={projects.isUnavailable}
          disabled={busy()}
          onOpen={openRecentProject}
          onRemove={removeRecentProject}
        />
      </div>

      <ProjectCreateDialog
        open={createOpen()}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => navigate(`/session/${encodeURIComponent(created.session.id)}`)}
      />
    </main>
  )
}
