import { tr } from "../../i18n/i18n-context"
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
    projects.loadRecentProjects().catch((cause) => setError(errorMessage(cause, tr("projects.unable-to-read-recent-items"))))
  })

  async function openSelectedProject() {
    setBusy(true)
    setError(undefined)
    try {
      const opened = await projects.chooseAndOpenProject()
      if (opened) navigate("/workspace")
    } catch (cause) {
      setError(errorMessage(cause, tr("projects.unable-to-open-project")))
    } finally {
      setBusy(false)
    }
  }

  async function openRecentProject(path: string) {
    setBusy(true)
    setError(undefined)
    try {
      await projects.openProject(path)
      navigate("/workspace")
    } catch (cause) {
      setError(errorMessage(cause, tr("projects.unable-to-open-project")))
    } finally {
      setBusy(false)
    }
  }

  async function removeRecentProject(path: string) {
    setBusy(true)
    setError(undefined)
    try {
      await projects.removeRecentProject(path)
    } catch (cause) {
      setError(errorMessage(cause, tr("projects.unable-to-remove-recent-items")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main class="welcome-page">
      <div class="welcome-layout">
        <section class="welcome-intro" aria-labelledby="welcome-title">
          <h1 id="welcome-title">JYYCode</h1>

          <div class="welcome-actions" aria-label={tr("projects.project-operations")}>
            <Button class="welcome-action" loading={busy()} loadingLabel={tr("projects.opening")} onClick={openSelectedProject}>
              <FolderOpen aria-hidden="true" />
              <strong>{tr("projects.open-directory")}</strong>
            </Button>
            <Button class="welcome-action" variant="secondary" disabled={busy()} onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              <strong>{tr("projects.new-project")}</strong>
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
