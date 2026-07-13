import { Show, createSignal } from "solid-js"
import { FolderSearch, GitBranch } from "lucide-solid"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import {
  GitInitializationError,
  errorMessage,
  type CreatedProject,
} from "./project-controller"
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
      setError(errorMessage(cause, "无法选择父目录"))
    }
  }

  function validate() {
    if (!parent().trim()) {
      setError("请选择父目录")
      queueMicrotask(() => parentInput?.focus())
      return false
    }
    if (!name().trim()) {
      setError("请输入项目名称")
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
        setError(`Git 初始化失败：${errorMessage(cause.originalError)}`)
      } else {
        setError(errorMessage(cause, "创建项目失败"))
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
      setError(`Git 初始化失败：${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      title="新建项目"
      description="创建目录，并在本地 JYYCode 后端中开启第一个 Session。"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>
            取消
          </Button>
          <Button type="submit" form="project-create-form" loading={busy()} loadingLabel="正在创建">
            创建并进入
          </Button>
        </>
      }
    >
      <form id="project-create-form" class="project-create-form" onSubmit={submit} noValidate>
        <div class="project-field">
          <label for="project-parent">父目录</label>
          <div class="project-field__picker">
            <input
              ref={parentInput}
              id="project-parent"
              value={parent()}
              placeholder="选择项目所在目录"
              readOnly
              aria-describedby="project-parent-hint"
            />
            <Button variant="secondary" onClick={chooseParent}>
              <FolderSearch aria-hidden="true" />
              选择
            </Button>
          </div>
          <span id="project-parent-hint" class="project-field__hint">
            将在该目录下创建新的项目文件夹
          </span>
        </div>

        <div class="project-field">
          <label for="project-name">项目名称</label>
          <input
            ref={nameInput}
            id="project-name"
            value={name()}
            placeholder="例如 my-agent-app"
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
            <strong>初始化 Git</strong>
            <small>在新目录中创建 Git 仓库</small>
          </span>
        </label>

        <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
        <Show when={gitFailure()}>
          <Button class="project-create-form__retry" variant="secondary" disabled={busy()} onClick={retryGit}>
            重试初始化 Git
          </Button>
        </Show>
      </form>
    </Dialog>
  )
}
