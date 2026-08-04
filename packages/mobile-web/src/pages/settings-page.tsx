import { ChevronRight, Delete, Lock, ShieldCheck } from "lucide-solid"

export function SettingsPage(props: {
  summaryOnly: boolean
  notifications: boolean
  onSummaryOnly: (value: boolean) => void
  onNotifications: (value: boolean) => void
  onClear: () => Promise<void>
  onRelock: () => void
  onBack: () => void
}) {
  return (
    <section class="page settings-page">
      <header class="page-header">
        <button class="icon-button" aria-label="返回" onClick={props.onBack}>
          ‹
        </button>
        <div>
          <span class="wordmark">设备与隐私</span>
          <p>浏览器本地安全设置</p>
        </div>
      </header>
      <section class="settings-list">
        <SettingToggle
          title="仅显示摘要（默认）"
          description="完整对话和代码改动仅在你主动打开时加载。"
          checked={props.summaryOnly}
          onChange={props.onSummaryOnly}
        />
        <SettingToggle
          title="前台实时更新"
          description="Safari 打开时通过加密连接接收任务状态。"
          checked
          onChange={() => undefined}
          disabled
        />
        <SettingToggle
          title="通知"
          description="当前仅在 Safari 打开时显示站内提醒。"
          checked={props.notifications}
          onChange={props.onNotifications}
        />
        <button class="settings-row" onClick={() => void props.onClear()}>
          <Delete />
          <span>
            <strong>清除本地缓存</strong>
            <small>删除配对信息、加密密钥和离线页面缓存。</small>
          </span>
          <ChevronRight />
        </button>
        <button class="settings-row" onClick={props.onRelock}>
          <Lock />
          <span>
            <strong>重新锁定</strong>
            <small>下次查看任务时需要重新解锁。</small>
          </span>
          <ChevronRight />
        </button>
      </section>
      <section class="device-security">
        <ShieldCheck />
        <span>
          <strong>内容按需加载</strong>
          <small>中继和浏览器通知不包含任务正文、代码、路径或密钥。</small>
        </span>
      </section>
    </section>
  )
}

function SettingToggle(props: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label class="settings-row">
      <span>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  )
}
