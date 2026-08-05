export type SoundEffectName =
  | "click"
  | "toggle-on"
  | "toggle-off"
  | "send"
  | "typing"
  | "agent-start"
  | "agent-end"
  | "error"
  | "attention"
  | "blackboard"
  | "panel-open"
  | "panel-close"
  | "mode-switch"
  | "confirm"
  | "cancel"

export function isSoundEffectName(value: unknown): value is SoundEffectName {
  return typeof value === "string" && (soundEffects as Record<string, unknown>)[value] !== undefined
}

type AudioContextConstructor = typeof AudioContext

let sharedContext: AudioContext | undefined
const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>()

function audioContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined
  const constructor: AudioContextConstructor | undefined =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  if (!constructor) return undefined
  sharedContext ??= new constructor()
  return sharedContext
}

function noiseBuffer(context: AudioContext) {
  let buffer = noiseBuffers.get(context)
  if (buffer) return buffer
  buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.6), context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
  noiseBuffers.set(context, buffer)
  return buffer
}

type ToneOptions = {
  frequency: number
  endFrequency?: number
  start: number
  duration: number
  volume?: number
  type?: OscillatorType
  attack?: number
  release?: number
}

function tone(
  context: AudioContext,
  master: GainNode,
  options: ToneOptions,
) {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const start = Math.max(options.start, context.currentTime)
  const duration = Math.max(options.duration, 0.03)
  const volume = Math.min(Math.max(options.volume ?? 0.12, 0), 0.4)
  const attack = Math.min(options.attack ?? 0.005, duration * 0.35)
  const release = Math.min(options.release ?? 0.06, duration * 0.4)

  oscillator.type = options.type ?? "sine"
  oscillator.frequency.setValueAtTime(options.frequency, start)
  if (options.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(options.endFrequency, 1), start + duration)
  }
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(volume, start + attack)
  gain.gain.exponentialRampToValueAtTime(volume, start + Math.max(duration - release, attack + 0.01))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain)
  gain.connect(master)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.03)
}

type NoiseOptions = {
  start: number
  duration: number
  volume?: number
  frequency: number
  endFrequency?: number
  q?: number
  filterType?: BiquadFilterType
}

function noiseBurst(
  context: AudioContext,
  master: GainNode,
  options: NoiseOptions,
) {
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  const start = Math.max(options.start, context.currentTime)
  const duration = Math.max(options.duration, 0.02)
  const volume = Math.min(Math.max(options.volume ?? 0.08, 0), 0.3)

  source.buffer = noiseBuffer(context)
  filter.type = options.filterType ?? "bandpass"
  filter.frequency.setValueAtTime(options.frequency, start)
  if (options.endFrequency !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(options.endFrequency, 20), start + duration)
  }
  filter.Q.value = options.q ?? (options.filterType === "lowpass" ? 0.6 : 1.1)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.01, duration * 0.3))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  source.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  source.start(start)
  source.stop(start + duration + 0.03)
}

function mechanicalClick(
  context: AudioContext,
  master: GainNode,
  options: {
    start: number
    cutoff?: number
    body?: number
    volume?: number
  },
) {
  const start = Math.max(options.start, context.currentTime)
  noiseBurst(context, master, {
    start,
    duration: 0.03,
    volume: options.volume ?? 0.1,
    frequency: options.cutoff ?? 900,
    q: 0.5,
    filterType: "lowpass",
  })
  tone(context, master, {
    frequency: options.body ?? 220,
    start,
    duration: 0.04,
    volume: (options.volume ?? 0.1) * 0.45,
    type: "sine",
    attack: 0.002,
    release: 0.024,
  })
}

function playPattern(context: AudioContext, master: GainNode, name: SoundEffectName) {
  const now = context.currentTime
  switch (name) {
    case "click":
      mechanicalClick(context, master, { start: now, cutoff: 950, body: 220, volume: 0.19 })
      break
    case "toggle-on":
      mechanicalClick(context, master, { start: now, cutoff: 900, body: 240, volume: 0.17 })
      mechanicalClick(context, master, { start: now + 0.045, cutoff: 700, body: 200, volume: 0.13 })
      break
    case "toggle-off":
      mechanicalClick(context, master, { start: now, cutoff: 750, body: 200, volume: 0.17 })
      mechanicalClick(context, master, { start: now + 0.045, cutoff: 600, body: 180, volume: 0.13 })
      break
    case "send":
      mechanicalClick(context, master, { start: now, cutoff: 1000, body: 260, volume: 0.19 })
      break
    case "typing":
      tone(context, master, { frequency: 480, endFrequency: 420, start: now, duration: 0.035, volume: 0.08, type: "triangle", attack: 0.004, release: 0.025 })
      break
    case "agent-start":
      noiseBurst(context, master, { start: now, duration: 0.26, volume: 0.1, frequency: 150, endFrequency: 450, q: 0.5, filterType: "lowpass" })
      tone(context, master, { frequency: 130, start: now, duration: 0.28, volume: 0.17, release: 0.14 })
      break
    case "agent-end":
      tone(context, master, { frequency: 520, start: now, duration: 0.22, volume: 0.13, release: 0.11 })
      tone(context, master, { frequency: 780, start: now + 0.05, duration: 0.26, volume: 0.1, release: 0.13 })
      break
    case "error":
      tone(context, master, { frequency: 130, start: now, duration: 0.26, volume: 0.14, release: 0.14 })
      tone(context, master, { frequency: 88, start: now + 0.02, duration: 0.24, volume: 0.11, release: 0.14 })
      break
    case "attention":
      mechanicalClick(context, master, { start: now, cutoff: 550, body: 190, volume: 0.09 })
      mechanicalClick(context, master, { start: now + 0.11, cutoff: 480, body: 170, volume: 0.09 })
      break
    case "blackboard":
      mechanicalClick(context, master, { start: now, cutoff: 850, body: 220, volume: 0.09 })
      mechanicalClick(context, master, { start: now + 0.055, cutoff: 650, body: 190, volume: 0.08 })
      break
    case "panel-open":
      noiseBurst(context, master, { start: now, duration: 0.22, volume: 0.11, frequency: 180, endFrequency: 480, q: 0.45, filterType: "lowpass" })
      tone(context, master, { frequency: 160, endFrequency: 300, start: now, duration: 0.2, volume: 0.06, type: "sine", attack: 0.015, release: 0.1 })
      break
    case "panel-close":
      noiseBurst(context, master, { start: now, duration: 0.22, volume: 0.11, frequency: 480, endFrequency: 180, q: 0.45, filterType: "lowpass" })
      tone(context, master, { frequency: 300, endFrequency: 160, start: now, duration: 0.2, volume: 0.06, type: "sine", attack: 0.015, release: 0.1 })
      break
    case "mode-switch":
      mechanicalClick(context, master, { start: now, cutoff: 700, body: 200, volume: 0.15 })
      mechanicalClick(context, master, { start: now + 0.05, cutoff: 950, body: 240, volume: 0.15 })
      break
    case "confirm":
      mechanicalClick(context, master, { start: now, cutoff: 800, body: 220, volume: 0.16 })
      mechanicalClick(context, master, { start: now + 0.06, cutoff: 950, body: 250, volume: 0.16 })
      break
    case "cancel":
      mechanicalClick(context, master, { start: now, cutoff: 800, body: 220, volume: 0.15 })
      mechanicalClick(context, master, { start: now + 0.06, cutoff: 600, body: 180, volume: 0.15 })
      break
  }
}

const lastPlayedAt = new Map<SoundEffectName, number>()

export function playSound(name: SoundEffectName) {
  const context = audioContext()
  if (!context) return
  const now = performance.now()
  if (now - (lastPlayedAt.get(name) ?? Number.NEGATIVE_INFINITY) < 28) return
  lastPlayedAt.set(name, now)

  if (context.state === "suspended") void context.resume()
  const master = context.createGain()
  master.gain.value = 0.85
  master.connect(context.destination)
  playPattern(context, master, name)
}

export function resetSoundEngineForTests() {
  lastPlayedAt.clear()
  sharedContext = undefined
}

const soundEffects: Record<SoundEffectName, true> = {
  click: true,
  "toggle-on": true,
  "toggle-off": true,
  send: true,
  typing: true,
  "agent-start": true,
  "agent-end": true,
  error: true,
  attention: true,
  blackboard: true,
  "panel-open": true,
  "panel-close": true,
  "mode-switch": true,
  confirm: true,
  cancel: true,
}
