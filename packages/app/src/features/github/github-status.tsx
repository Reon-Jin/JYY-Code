import { tr } from "../../i18n/i18n-context"
import type { GitHubAvailability } from "@jyycode-ai/sdk/v2/client"
import { Check, Copy, RefreshCw } from "lucide-solid"
import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"

const recovery = () =>
  ({
    "missing-gh": {
      title: tr("github.github-cli-is-not-installed"),
      detail: tr("github.re-detect-after-installing-github-cli-without-restarting"),
      command: "winget install --id GitHub.cli",
    },
    "not-authenticated": {
      title: tr("github.github-cli-not-logged-in-yet"),
      detail: tr("github.please-complete-the-browser-login-in-the-terminal"),
      command: "gh auth login",
    },
    "not-github-repo": {
      title: tr("github.the-remote-end-is-currently-not-associated-with"),
      detail: tr("github.please-confirm-that-git-remote-points-to-the"),
      command: "git remote -v",
    },
    "command-failed": {
      title: tr("github.github-cli-detection-failed"),
      detail: tr("github.check-network-and-github-cli-status-and-try"),
      command: "gh auth status",
    },
  }) as const

export function GitHubStatus(props: {
  status?: GitHubAvailability
  loading?: boolean
  error?: string
  onRetry: () => void
}) {
  const [copied, setCopied] = createSignal(false)
  const unavailable = () => (props.status?.available === false ? recovery()[props.status.reason] : undefined)

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
          <Spinner /> {tr("github.detecting-github-environment")}
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
              {tr("github.retest")}
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
                <Button size="small" variant="ghost" data-sound-effect="copy" onClick={() => void copyCommand()}>
                  <Show when={copied()} fallback={<Copy aria-hidden="true" />}>
                    <Check aria-hidden="true" />
                  </Show>
                  {copied() ? tr("github.copied") : tr("github.copy-command")}
                </Button>
              </div>
              <Button size="small" variant="secondary" onClick={props.onRetry}>
                <RefreshCw aria-hidden="true" />
                {tr("github.retest")}
              </Button>
            </section>
          )}
        </Show>
      </Show>
    </Show>
  )
}
