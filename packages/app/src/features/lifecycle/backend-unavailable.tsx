import { FileText, RotateCcw } from "lucide-solid"
import { Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { safeFailureMessage } from "./lifecycle-controller"
import "./lifecycle.css"

export type BackendUnavailableProps = {
  reason: string
  logPath?: string
  recovering?: boolean
  recoveryAvailable: boolean
  onRestart: () => void
  onBack: () => void
}

export function BackendUnavailable(props: BackendUnavailableProps) {
  return (
    <main class="lifecycle-failure" aria-labelledby="backend-unavailable-title">
      <div class="lifecycle-failure__content">
        <h1 id="backend-unavailable-title">本地后端不可用</h1>
        <p>JYYCode 无法连接到本地服务。已加载的数据不会在此页面显示敏感认证信息。</p>
        <InlineError message={safeFailureMessage(props.reason)} />
        <Show when={props.logPath}>
          {(path) => (
            <p class="lifecycle-failure__log">
              <FileText aria-hidden="true" />
              日志位置：<code>{path()}</code>
            </p>
          )}
        </Show>
        <div class="lifecycle-failure__actions">
          <Button
            disabled={!props.recoveryAvailable}
            loading={props.recovering}
            loadingLabel="正在重新启动"
            onClick={props.onRestart}
          >
            <RotateCcw aria-hidden="true" />
            重新启动后端
          </Button>
          <Button variant="secondary" onClick={props.onBack}>
            返回项目选择
          </Button>
        </div>
      </div>
    </main>
  )
}
