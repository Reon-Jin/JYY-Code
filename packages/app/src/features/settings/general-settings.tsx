import { createSignal, onMount, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { useDesktopBridge } from "../../platform/context"
import { applyTheme } from "./theme"
import { defaultDesktopSettings, type DesktopSettings } from "./settings-preferences"
import { ComingSoonSetting } from "./coming-soon-setting"

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "无法保存桌面设置"
}

export function GeneralSettings() {
  const bridge = useDesktopBridge()
  const [settings, setSettings] = createSignal<DesktopSettings>({ ...defaultDesktopSettings })
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  onMount(() => {
    void bridge
      .loadSettings()
      .then((value) => {
        setSettings(value)
        applyTheme(value.theme)
      })
      .catch((cause) => setError(message(cause)))
  })

  async function save(next: DesktopSettings) {
    const previous = settings()
    setError(undefined)
    setSettings(next)
    if (next.theme !== previous.theme) applyTheme(next.theme)
    setSaving(true)
    try {
      await bridge.saveSettings(next)
    } catch (cause) {
      setSettings(previous)
      applyTheme(previous.theme)
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="settings-sections">
      <Show when={error()}>{(value) => <InlineError message={value()} />}</Show>

      <section class="settings-card" aria-labelledby="startup-setting-title">
        <h3 id="startup-setting-title">启动时</h3>
        <fieldset class="settings-options" disabled={saving()}>
          <legend>选择桌面应用启动位置</legend>
          <label>
            <input
              type="radio"
              aria-label="恢复上次项目"
              name="startup"
              value="restore"
              checked={settings().startup === "restore"}
              onChange={() => void save({ ...settings(), startup: "restore" })}
            />
            <span><strong>恢复上次项目</strong><small>回到最近使用的项目和 Session。</small></span>
          </label>
          <label>
            <input
              type="radio"
              aria-label="启动时显示 Home"
              name="startup"
              value="home"
              checked={settings().startup === "home"}
              onChange={() => void save({ ...settings(), startup: "home" })}
            />
            <span><strong>启动时显示 Home</strong><small>每次启动都从项目选择页开始。</small></span>
          </label>
        </fieldset>
      </section>

      <section class="settings-card" aria-labelledby="appearance-setting-title">
        <h3 id="appearance-setting-title">外观</h3>
        <fieldset class="settings-options settings-options--inline" disabled={saving()}>
          <legend>颜色主题</legend>
          <label>
            <input
              type="radio"
              aria-label="深色"
              name="theme"
              value="dark"
              checked={settings().theme === "dark"}
              onChange={() => void save({ ...settings(), theme: "dark" })}
            />
            <span><strong>深色</strong></span>
          </label>
          <label>
            <input
              type="radio"
              aria-label="浅色"
              name="theme"
              value="light"
              checked={settings().theme === "light"}
              onChange={() => void save({ ...settings(), theme: "light" })}
            />
            <span><strong>浅色</strong></span>
          </label>
        </fieldset>
      </section>

      <ComingSoonSetting title="语言" reason="真正的语言切换需要先建立集中式消息目录。">
        <label class="settings-select-label">
          <span>语言</span>
          <select aria-label="语言" disabled>
            <option>简体中文</option>
          </select>
        </label>
      </ComingSoonSetting>

      <ComingSoonSetting
        title="Apple 风格液态玻璃"
        reason="需要完整视觉系统以及 Windows 和 WebView 验证，不能只添加局部背景效果。"
      >
        <label class="settings-disabled-check">
          <input type="checkbox" aria-label="Apple 风格液态玻璃" disabled />
          Apple 风格液态玻璃
        </label>
      </ComingSoonSetting>

      <ComingSoonSetting title="Windows 通知" reason="原生通知能力和前台、后台事件规则尚未接入。">
        <fieldset class="settings-placeholder-options" disabled>
          <legend>通知触发条件</legend>
          {(["回复完成", "等待权限", "Agent 提问"] as const).map((label) => (
            <label><input type="checkbox" />{label}</label>
          ))}
        </fieldset>
      </ComingSoonSetting>
    </div>
  )
}
