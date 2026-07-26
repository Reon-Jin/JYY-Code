import { For, Show, createSignal, onMount } from "solid-js"
import QRCode from "qrcode"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { useDesktopBridge } from "../../platform/context"
import type { MobileDevice, MobilePairingInvitation } from "../../platform/types"

export function MobileSettings() {
  const bridge = useDesktopBridge()
  const [devices, setDevices] = createSignal<MobileDevice[]>([])
  const [pairing, setPairing] = createSignal<MobilePairingInvitation>()
  const [loading, setLoading] = createSignal(true)
  const [starting, setStarting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let qrCanvas: HTMLCanvasElement | undefined

  function requireMobileBridge() {
    if (!bridge.mobileListDevices || !bridge.mobileStartPairing || !bridge.mobileRevokeDevice) {
      throw new Error("Mobile companion is unavailable in this desktop build.")
    }
    return bridge
  }

  async function loadDevices() {
    setLoading(true)
    setFailure(undefined)
    try {
      setDevices(await requireMobileBridge().mobileListDevices!())
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Unable to load paired mobile devices.")
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
      setFailure(cause instanceof Error ? cause.message : "Unable to start mobile pairing.")
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
      setFailure(cause instanceof Error ? cause.message : "Unable to revoke this mobile device.")
    }
  }

  onMount(() => void loadDevices())

  return (
    <div class="settings-sections mobile-settings">
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <section class="settings-card" aria-labelledby="mobile-pairing-title">
        <h3 id="mobile-pairing-title">Pair an iPhone</h3>
        <p class="settings-description">
          Scan a time-limited QR code from the JYYCode iPhone app. The code expires after five minutes and does not
          expose your local backend address or credentials.
        </p>
        <Button loading={starting()} onClick={() => void startPairing()}>
          Show pairing QR code
        </Button>
        <Show when={pairing()}>
          {(invitation) => (
            <div class="mobile-settings__qr" role="status">
              <canvas ref={(element) => (qrCanvas = element)} aria-label="Mobile pairing QR code" />
              <p>Expires {new Date(invitation().expiresAt * 1000).toLocaleTimeString()}.</p>
            </div>
          )}
        </Show>
      </section>

      <section class="settings-card" aria-labelledby="mobile-devices-title">
        <h3 id="mobile-devices-title">Paired devices</h3>
        <p class="settings-description">Revoking a device immediately prevents it from receiving future remote traffic.</p>
        <Show when={loading()}>
          <p role="status">Loading paired devices…</p>
        </Show>
        <Show when={!loading() && devices().length === 0}>
          <p class="settings-card__hint">No iPhone is paired yet.</p>
        </Show>
        <div class="mobile-settings__devices">
          <For each={devices()}>
            {(device) => (
              <article>
                <div>
                  <strong>{device.name}</strong>
                  <small>Paired {new Date(device.pairedAt * 1000).toLocaleString()}</small>
                </div>
                <Button variant="danger" size="small" onClick={() => void revoke(device.id)}>
                  Revoke
                </Button>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
