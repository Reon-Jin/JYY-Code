import { onCleanup } from "solid-js"
import type { DesktopBridge } from "../../platform/types"
import { createSoundEffectsController } from "./sound-effects"

export function SoundEffectsHost(props: { bridge: DesktopBridge }) {
  const controller = createSoundEffectsController({ bridge: props.bridge })
  onCleanup(() => controller.dispose())
  return null
}
