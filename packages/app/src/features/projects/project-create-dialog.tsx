import { tr } from "../../i18n/i18n-context"
import { Show, createSignal } from "solid-js"
import { FolderSearch, GitBranch } from "lucide-solid"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { GitInitializationError, errorMessage, type CreatedProject } from "./project-controller"
import { useProjects } from "./project-context"

export type ProjectCreateDialogProps = {
  open: boolean
  onClose: () => void
  onCreated: (project: CreatedProject) => void
}

export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  const projects = useProjects()
  const [parent, setParent] = createSignal("")
  const [name, setName] = createSignal("")
  const [initGit, setInitGit] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [gitFailure, setGitFailure] = createSignal<GitInitializationError>()
  const [busy, setBusy] = createSignal(false)
  let parentInput: HTMLInputElement | undefined
  let nameInput: HTMLInputElement | undefined

  async function chooseParent() {
    try {
      const directory = await projects.chooseDirectory()
      if (directory) {
        setParent(directory)
        setError(undefined)
        queueMicrotask(() => nameInput?.focus())
      }
    } catch (cause) {
      setError(errorMessage(cause, tr("projects.unable-to-select-parent-directory")))
    }
  }

  function validate() {
    if (!parent().trim()) {
      setError(tr("projects.please-select-a-parent-directory"))
      queueMicrotask(() => parentInput?.focus())
      return false
    }
    if (!name().trim()) {
      setError(tr("projects.please-enter-project-name"))
      queueMicrotask(() => nameInput?.focus())
      return false
    }
    return true
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!validate()) return

    setBusy(true)
    setError(undefined)
    setGitFailure(undefined)
    try {
      const created = await projects.createProject({
        parent: parent().trim(),
        name: name().trim(),
        initGit: initGit(),
      })
      props.onCreated(created)
    } catch (cause) {
      if (cause instanceof GitInitializationError) {
        setGitFailure(cause)
        setError(tr("projects.git-initialization-failed", { reason: errorMessage(cause.originalError) }))
      } else {
        setError(errorMessage(cause, tr("projects.failed-to-create-project")))
      }
    } finally {
      setBusy(false)
    }
  }

  async function retryGit() {
    const failure = gitFailure()
    if (!failure) return

    setBusy(true)
    setError(undefined)
    try {
      const created = await projects.continueAfterGitFailure(failure)
      props.onCreated(created)
    } catch (cause) {
      setError(tr("projects.git-initialization-failed", { reason: errorMessage(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      title={tr("projects.new-project")}
      description={tr("projects.create-a-directory-and-open-the-first-session")}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button type="submit" form="project-create-form" loading={busy()} loadingLabel={tr("projects.creating")}>
            {tr("projects.create-and-enter")}
          </Button>
        </>
      }
    >
      <form id="project-create-form" class="project-create-form" onSubmit={submit} noValidate>
        <div class="project-field">
          <label for="project-parent">{tr("projects.parent-directory")}</label>
          <div class="project-field__picker">
            <input
              ref={parentInput}
              id="project-parent"
              value={parent()}
              placeholder={tr("projects.select-the-directory-where-the-project-is-located")}
              readOnly
              aria-describedby="project-parent-hint"
            />
            <Button variant="secondary" onClick={chooseParent}>
              <FolderSearch aria-hidden="true" />
              {tr("projects.choose")}
            </Button>
          </div>
          <span id="project-parent-hint" class="project-field__hint">
            {tr("projects.a-new-project-folder-will-be-created-in")}
          </span>
        </div>

        <div class="project-field">
          <label for="project-name">{tr("projects.project-name")}</label>
          <input
            ref={nameInput}
            id="project-name"
            value={name()}
            placeholder={tr("projects.for-example-my-agent-app")}
            onInput={(event) => setName(event.currentTarget.value)}
            autocomplete="off"
          />
        </div>

        <label class="project-checkbox" for="project-init-git">
          <input
            id="project-init-git"
            type="checkbox"
            checked={initGit()}
            onChange={(event) => setInitGit(event.currentTarget.checked)}
          />
          <span class="project-checkbox__mark" aria-hidden="true">
            <GitBranch />
          </span>
          <span>
            <strong>{tr("projects.initialize-git")}</strong>
            <small>{tr("projects.create-a-git-repository-in-a-new-directory")}</small>
          </span>
        </label>

        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
        <Show when={gitFailure()}>
          <Button class="project-create-form__retry" variant="secondary" disabled={busy()} onClick={retryGit}>
            {tr("projects.retry-initializing-git")}
          </Button>
        </Show>
      </form>
    </Dialog>
  )
}
