import { useNavigate } from "@solidjs/router"
import { FolderOpen, Plus, ShieldCheck } from "lucide-solid"
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
      <header class="welcome-brand" aria-label="JYYCode">
        <span class="welcome-brand__mark" aria-hidden="true">
          J
        </span>
        <span class="welcome-brand__name">JYYCode</span>
        <span class="welcome-brand__edition">Desktop Preview</span>
      </header>

      <div class="welcome-layout">
        <section class="welcome-intro" aria-labelledby="welcome-title">
          <div class="welcome-intro__status">
            <span aria-hidden="true" /> Windows 本地工作区
          </div>
          <h1 id="welcome-title">从这里开始，<br />让代码保持流动。</h1>
          <p>
            桌面端与 JYYCode TUI 共享同一套后端。打开已有目录，或创建一个干净的新项目。
          </p>

          <div class="welcome-actions" aria-label="项目操作">
            <Button class="welcome-action" loading={busy()} loadingLabel="正在打开" onClick={openSelectedProject}>
              <FolderOpen aria-hidden="true" />
              <span>
                <strong>打开现有目录</strong>
                <small>继续本地项目</small>
              </span>
            </Button>
            <Button class="welcome-action" disabled={busy()} onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              <span>
                <strong>新建项目</strong>
                <small>创建目录与 Session</small>
              </span>
            </Button>
          </div>

          <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>

          <div class="welcome-assurance">
            <ShieldCheck aria-hidden="true" />
            <span>凭据仅保留在桌面进程内，项目请求通过本机后端完成。</span>
          </div>
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
