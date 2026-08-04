import { Camera, ChevronRight, LockKeyhole, Plus, Settings, Trash2 } from "lucide-solid"
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { StoredDevice } from "../lib/device-store"
import { startQrScanner } from "../lib/qr-scanner"

export function DevicesPage(props: {
  devices: StoredDevice[]
  activeDeviceID?: string
  onPair: (payload: string) => Promise<void>
  onSelect: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSettings: () => void
}) {
  const [adding, setAdding] = createSignal(false)
  const [payload, setPayload] = createSignal("")
  const [message, setMessage] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  let video: HTMLVideoElement | undefined
  let stopScanner: (() => void) | undefined
  onCleanup(() => stopScanner?.())

  async function scan() {
    if (!video) return
    setMessage(undefined)
    stopScanner?.()
    try {
      stopScanner = await startQrScanner(
        video,
        (result) => {
          setPayload(result)
          stopScanner?.()
        },
        setMessage,
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法打开相机")
    }
  }
  async function pair() {
    if (!payload().trim()) return
    setBusy(true)
    setMessage(undefined)
    try {
      await props.onPair(payload().trim())
      setAdding(false)
      setPayload("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配对失败")
    } finally {
      setBusy(false)
    }
  }

  function beginPairing() {
    setAdding(true)
    window.setTimeout(() => void scan(), 0)
  }

  return (
    <section class="page devices-page">
      <header class="page-header">
        <div>
          <span class="wordmark">设备</span>
          <p>已配对的电脑与浏览器</p>
        </div>
        <button class="icon-button" aria-label="设置与隐私" onClick={props.onSettings}>
          <Settings />
        </button>
      </header>
      <button class="add-device" onClick={beginPairing}>
        <Plus />
        扫描电脑二维码
      </button>
      <section class="device-security">
        <LockKeyhole />
        <span>
          <strong>安全配对，无需账号</strong>
          <small>任务内容通过加密通道传输；电脑端可随时撤销此浏览器。</small>
        </span>
      </section>
      <h2 class="section-title">已配对设备</h2>
      <Show
        when={props.devices.length > 0}
        fallback={<p class="empty-state">尚未配对电脑。请在桌面端“设置 → 移动网页版”中显示二维码。</p>}
      >
        <div class="device-list">
          <For each={props.devices}>
            {(device) => (
              <article class="device-row" classList={{ "is-selected": props.activeDeviceID === device.id }}>
                <button onClick={() => void props.onSelect(device.id)}>
                  <span class="device-icon">▣</span>
                  <span>
                    <strong>{device.name}</strong>
                    <small>
                      {device.lastSeen ? `上次同步：${new Date(device.lastSeen).toLocaleString("zh-CN")}` : "尚未同步"}
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button class="text-danger" onClick={() => void props.onRemove(device.id)}>
                  <Trash2 />
                  移除
                </button>
              </article>
            )}
          </For>
        </div>
      </Show>
      <Show when={adding()}>
        <div class="sheet-backdrop" role="presentation" onClick={() => setAdding(false)}>
          <section
            class="project-sheet device-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="扫描电脑二维码"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span class="eyebrow">添加电脑</span>
                <h2>扫描电脑二维码</h2>
              </div>
            </header>
            <video class="scanner-video" ref={video} muted playsinline />
            <p class="scanner-hint">请使用后置摄像头，对准电脑上的大号二维码；保持约 15–25 厘米距离并避免反光。</p>
            <button class="secondary-button" onClick={() => void scan()}>
              <Camera />
              重新打开相机
            </button>
            <label>
              或粘贴二维码内容
              <textarea
                placeholder="仅用于无法使用相机时"
                value={payload()}
                onInput={(event) => setPayload(event.currentTarget.value)}
              />
            </label>
            <Show when={message()}>{(text) => <p class="form-error">{text()}</p>}</Show>
            <div class="button-row">
              <button class="secondary-button" onClick={() => setAdding(false)}>
                取消
              </button>
              <button class="primary-button" disabled={!payload().trim() || busy()} onClick={() => void pair()}>
                {busy() ? "正在配对…" : "完成配对"}
              </button>
            </div>
          </section>
        </div>
      </Show>
    </section>
  )
}
