import type { GitHubAvailability } from "@jyycode-ai/sdk/v2/client"
import { Check, Copy, RefreshCw } from "lucide-solid"
import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"

const recovery = {
  "missing-gh": {
    title: "GitHub CLI 未安装",
    detail: "安装 GitHub CLI 后重新检测，无需重启或重装 Desktop。",
    command: "winget install --id GitHub.cli",
  },
  "not-authenticated": {
    title: "GitHub CLI 尚未登录",
    detail: "请在终端完成浏览器登录。Desktop 不会要求你粘贴访问令牌。",
    command: "gh auth login",
  },
  "not-github-repo": {
    title: "当前远端未关联 GitHub",
    detail: "请确认 Git remote 指向 GitHub 仓库后重新检测。",
    command: "git remote -v",
  },
  "command-failed": {
    title: "GitHub CLI 检测失败",
    detail: "检查网络与 GitHub CLI 状态后重试。",
    command: "gh auth status",
  },
} as const

export function GitHubStatus(props: {
  status?: GitHubAvailability
  loading?: boolean
  error?: string
  onRetry: () => void
}) {
  const [copied, setCopied] = createSignal(false)
  const unavailable = () => (props.status?.available === false ? recovery[props.status.reason] : undefined)

  async function copyCommand() {
    const command = unavailable()?.command
    if (!command) return
    await navigator.clipboard?.writeText(command)
    setCopied(true)
  }

  return (
    <Show
      when={!props.loading}
      fallback={
        <p class="github-status__loading" role="status">
          <Spinner /> 正在检测 GitHub 环境
        </p>
      }
    >
      <Show
        when={!props.error}
        fallback={
          <div class="github-status">
            <InlineError message={props.error!} />
            <Button size="small" variant="secondary" onClick={props.onRetry}>
              <RefreshCw aria-hidden="true" />
              重新检测
            </Button>
          </div>
        }
      >
        <Show when={unavailable()}>
          {(item) => (
            <section class="github-status" aria-labelledby="github-status-title">
              <h3 id="github-status-title">{item().title}</h3>
              <p>{props.status?.available === false ? props.status.message : item().detail}</p>
              <p>{item().detail}</p>
              <div class="github-status__command">
                <code>{item().command}</code>
                <Button size="small" variant="ghost" onClick={() => void copyCommand()}>
                  <Show when={copied()} fallback={<Copy aria-hidden="true" />}>
                    <Check aria-hidden="true" />
                  </Show>
                  {copied() ? "已复制" : "复制命令"}
                </Button>
              </div>
              <Button size="small" variant="secondary" onClick={props.onRetry}>
                <RefreshCw aria-hidden="true" />
                重新检测
              </Button>
            </section>
          )}
        </Show>
      </Show>
    </Show>
  )
}
