import { For, Show, createSignal, onMount } from "solid-js"
import QRCode from "qrcode"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { useDesktopBridge } from "../../platform/context"
import type { MobileDevice, MobilePairingInvitation } from "../../platform/types"
import { useI18n } from "../../i18n/i18n-context"

export function MobileSettings() {
  const bridge = useDesktopBridge()
  const i18n = useI18n()
  const [devices, setDevices] = createSignal<MobileDevice[]>([])
  const [pairing, setPairing] = createSignal<MobilePairingInvitation>()
  const [loading, setLoading] = createSignal(true)
  const [starting, setStarting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let qrCanvas: HTMLCanvasElement | undefined

  function requireMobileBridge() {
    if (!bridge.mobileListDevices || !bridge.mobileStartPairing || !bridge.mobileRevokeDevice) {
      throw new Error(i18n.t("settings.mobile-unavailable"))
    }
    return bridge
  }

  async function loadDevices() {
    setLoading(true)
    setFailure(undefined)
    try {
      setDevices(await requireMobileBridge().mobileListDevices!())
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : i18n.t("settings.mobile-load-failed"))
    } finally {
      setLoading(false)
    }
  }

  async function startPairing() {
    setStarting(true)
    setFailure(undefined)
    try {
      const invitation = await requireMobileBridge().mobileStartPairing!()
      setPairing(invitation)
      await Promise.resolve()
      if (qrCanvas) await QRCode.toCanvas(qrCanvas, invitation.qrPayload, { width: 220, margin: 1 })
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : i18n.t("settings.mobile-start-failed"))
    } finally {
      setStarting(false)
    }
  }

  async function revoke(deviceID: string) {
    setFailure(undefined)
    try {
      await requireMobileBridge().mobileRevokeDevice!(deviceID)
      await loadDevices()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : i18n.t("settings.mobile-revoke-failed"))
    }
  }

  onMount(() => void loadDevices())

  return (
    <div class="settings-sections mobile-settings">
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <section class="settings-card" aria-labelledby="mobile-pairing-title">
        <h3 id="mobile-pairing-title">{i18n.t("settings.mobile-pair-iphone")}</h3>
        <p class="settings-description">
          {i18n.t("settings.mobile-pair-description")}
        </p>
        <Button loading={starting()} onClick={() => void startPairing()}>
          {i18n.t("settings.mobile-show-qr")}
        </Button>
        <Show when={pairing()}>
          {(invitation) => (
            <div class="mobile-settings__qr" role="status">
              <canvas ref={(element) => (qrCanvas = element)} aria-label={i18n.t("settings.mobile-qr-label")} />
              <p>{i18n.t("settings.mobile-expires", { time: new Date(invitation().expiresAt * 1000).toLocaleTimeString(i18n.locale()) })}</p>
            </div>
          )}
        </Show>
      </section>

      <section class="settings-card" aria-labelledby="mobile-devices-title">
        <h3 id="mobile-devices-title">{i18n.t("settings.mobile-paired-devices")}</h3>
        <p class="settings-description">{i18n.t("settings.mobile-revoke-description")}</p>
        <Show when={loading()}>
          <p role="status">{i18n.t("settings.mobile-loading-devices")}</p>
        </Show>
        <Show when={!loading() && devices().length === 0}>
          <p class="settings-card__hint">{i18n.t("settings.mobile-no-devices")}</p>
        </Show>
        <div class="mobile-settings__devices">
          <For each={devices()}>
            {(device) => (
              <article>
                <div>
                  <strong>{device.name}</strong>
                  <small>{i18n.t("settings.mobile-paired-at", { time: new Date(device.pairedAt * 1000).toLocaleString(i18n.locale()) })}</small>
                </div>
                <Button variant="danger" size="small" onClick={() => void revoke(device.id)}>
                  {i18n.t("settings.mobile-revoke")}
                </Button>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
