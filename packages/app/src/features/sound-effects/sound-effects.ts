import type { DesktopBridge } from "../../platform/types"
import { isSoundEffectName, playSound, resetSoundEngineForTests, type SoundEffectName } from "./sound-engine"

export type { SoundEffectName } from "./sound-engine"

export type SoundEffectEvent =
  | { kind: "status"; eventID: string; sessionID: string; status: "running" | "retry" | "idle" }
  | { kind: "attention"; eventID: string }
  | { kind: "blackboard"; eventID: string }
  | { kind: "typing"; eventID: string }

const eventSubscribers = new Set<(event: SoundEffectEvent) => void>()
const sessionStatuses = new Map<string, "running" | "retry" | "idle">()

let enabled = false
let blackboardSuppressedUntil = 0
let lastTypingAt = Number.NEGATIVE_INFINITY

export function publishSoundEffectsEnabled(next: boolean) {
  enabled = next
}

export function publishSoundEffectEvent(event: SoundEffectEvent) {
  for (const subscriber of eventSubscribers) subscriber(event)
}

export function suppressNextBlackboardSound() {
  blackboardSuppressedUntil = performance.now() + 1_000
}

export function playSoundEffect(name: SoundEffectName) {
  if (!enabled) return
  playSound(name)
}

export function handleSoundEffectEvent(event: SoundEffectEvent) {
  if (event.kind === "status") {
    const previous = sessionStatuses.get(event.sessionID)
    sessionStatuses.set(event.sessionID, event.status)
    if (!enabled) return
    if (event.status === "running" && previous !== "running") {
      playSound("agent-start")
      return
    }
    if (event.status === "retry" && previous !== "retry") {
      playSound("error")
      return
    }
    if (event.status === "idle" && (previous === "running" || previous === "retry")) {
      playSound("agent-end")
    }
    return
  }
  if (!enabled) return
  if (event.kind === "attention") {
    playSound("attention")
    return
  }
  if (event.kind === "blackboard" && performance.now() >= blackboardSuppressedUntil) {
    playSound("blackboard")
    return
  }
  if (event.kind === "typing") {
    const now = performance.now()
    if (now - lastTypingAt < 70) return
    lastTypingAt = now
    playSound("typing")
  }
}

const interactiveSelector = [
  "button",
  "a[href]",
  "[role='button']",
  "[role='switch']",
  "[role='menuitem']",
  "[role='menuitemradio']",
  "[role='radio']",
  "[role='checkbox']",
  "input[type='checkbox']",
  "input[type='radio']",
  "select",
  "summary",
  "label",
].join(", ")

function toggledSound(control: Element): SoundEffectName | undefined {
  if (
    control.matches("[role='switch'], [role='radio'], [role='checkbox'], input[type='checkbox'], input[type='radio']")
  ) {
    const checked =
      control.getAttribute("aria-checked") === "true" || (control instanceof HTMLInputElement && control.checked)
    return checked ? "toggle-off" : "toggle-on"
  }
  if (control instanceof HTMLLabelElement) {
    const input = control.querySelector<HTMLInputElement>("input[type='checkbox'], input[type='radio']")
    if (input) return input.checked ? "toggle-off" : "toggle-on"
  }
  return undefined
}

export function soundEffectForTarget(target: EventTarget | null): SoundEffectName | undefined {
  if (!(target instanceof Element)) return undefined
  const override = target.closest<HTMLElement>("[data-sound-effect]")
  if (override?.dataset.soundEffect === "none") return undefined
  if (override?.dataset.soundEffect && isSoundEffectName(override.dataset.soundEffect)) {
    return override.dataset.soundEffect
  }
  const control = target.closest<HTMLElement>(interactiveSelector)
  if (!control) return undefined
  const toggle = toggledSound(control)
  if (toggle) return toggle
  if (control.matches("select, [role='menuitem'], [role='menuitemradio']")) return "mode-switch"
  return "click"
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return
  const sound = soundEffectForTarget(event.target)
  if (sound) playSoundEffect(sound)
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest("input, textarea, select, [contenteditable='true']")) return
  const sound = soundEffectForTarget(target)
  if (sound) playSoundEffect(sound)
}

export function createSoundEffectsController(input: { bridge: DesktopBridge }) {
  let disposed = false

  void input.bridge
    .loadSettings()
    .then((settings) => {
      if (!disposed) publishSoundEffectsEnabled(settings.soundEffects)
    })
    .catch(() => {
      // Stay silent when the preference cannot be read.
    })

  const onEvent = (event: SoundEffectEvent) => handleSoundEffectEvent(event)
  eventSubscribers.add(onEvent)
  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("keydown", onKeyDown, true)

  return {
    dispose() {
      disposed = true
      eventSubscribers.delete(onEvent)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    },
  }
}

export function resetSoundEffectsForTests() {
  publishSoundEffectsEnabled(false)
  sessionStatuses.clear()
  blackboardSuppressedUntil = 0
  lastTypingAt = Number.NEGATIVE_INFINITY
  eventSubscribers.clear()
  resetSoundEngineForTests()
}
