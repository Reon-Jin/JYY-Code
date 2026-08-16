export type SoundEffectName =
  | "click"
  | "toggle-on"
  | "toggle-off"
  | "send"
  | "typing"
  | "agent-start"
  | "agent-end"
  | "goal-start"
  | "goal-end"
  | "error"
  | "attention"
  | "blackboard"
  | "panel-open"
  | "panel-close"
  | "mode-switch"
  | "confirm"
  | "cancel"
  | "copy"
  | "attach"
  | "stop"
  | "queue-add"
  | "delete"

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
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

function tone(context: AudioContext, master: GainNode, options: ToneOptions) {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const start = Math.max(options.start, context.currentTime)
  const duration = Math.max(options.duration, 0.03)
  const volume = clamp(options.volume ?? 0.12, 0, 0.4)
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

function noiseBurst(context: AudioContext, master: GainNode, options: NoiseOptions) {
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  const start = Math.max(options.start, context.currentTime)
  const duration = Math.max(options.duration, 0.02)
  const volume = clamp(options.volume ?? 0.08, 0, 0.3)

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

type BodyPartial = {
  frequency: number
  amplitude: number
  /** Exponential decay time constant in seconds. */
  decay: number
}

type StruckBodyOptions = {
  start: number
  partials: BodyPartial[]
  volume?: number
  duration?: number
  type?: OscillatorType
  attack?: number
}

/**
 * Modal synthesis for a struck physical object. Each partial rings with its own
 * exponential decay, so wood, glass, stone and marimba bars all get a natural,
 * non-synthetic character.
 */
function struckBody(context: AudioContext, master: GainNode, options: StruckBodyOptions) {
  const start = Math.max(options.start, context.currentTime)
  const volume = clamp(options.volume ?? 0.12, 0, 0.4)
  const attack = Math.min(options.attack ?? 0.003, 0.02)
  const duration = Math.max(options.duration ?? 0.6, 0.05)
  for (const partial of options.partials) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = options.type ?? "sine"
    oscillator.frequency.setValueAtTime(partial.frequency, start)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(volume * partial.amplitude, 0.0002), start + attack)
    gain.gain.setTargetAtTime(0.0001, start + attack, partial.decay)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.08)
  }
}

const woodBody = (base: number, decay = 0.06): BodyPartial[] => [
  { frequency: base, amplitude: 1, decay },
  { frequency: base * 2.76, amplitude: 0.38, decay: decay * 0.85 },
  { frequency: base * 5.4, amplitude: 0.16, decay: decay * 0.7 },
]

const glassBody = (base: number, decay = 0.4): BodyPartial[] => [
  { frequency: base, amplitude: 1, decay },
  { frequency: base * 2.32, amplitude: 0.3, decay: decay * 0.7 },
  { frequency: base * 4.14, amplitude: 0.1, decay: decay * 0.5 },
]

const stoneBody = (base: number, decay = 0.05): BodyPartial[] => [
  { frequency: base, amplitude: 1, decay },
  { frequency: base * 2.1, amplitude: 0.25, decay: decay * 0.8 },
  { frequency: base * 4.6, amplitude: 0.08, decay: decay * 0.6 },
]

const marimbaBody = (base: number, decay = 0.18): BodyPartial[] => [
  { frequency: base, amplitude: 1, decay },
  { frequency: base * 3.98, amplitude: 0.3, decay: decay * 0.65 },
  { frequency: base * 9.2, amplitude: 0.08, decay: decay * 0.45 },
]

type SwitchClickOptions = {
  start: number
  cutoff?: number
  body?: number
  low?: number
  volume?: number
}

/**
 * A physical micro-switch press: crisp contact transient, tiny resonant body
 * and a low-mass thump for weight.
 */
function switchClick(context: AudioContext, master: GainNode, options: SwitchClickOptions) {
  const start = Math.max(options.start, context.currentTime)
  const volume = clamp(options.volume ?? 0.14, 0, 0.3)
  const cutoff = options.cutoff ?? 2400
  const body = options.body ?? 1500
  const low = options.low ?? 200
  noiseBurst(context, master, {
    start,
    duration: 0.018,
    volume,
    frequency: cutoff,
    q: 0.9,
    filterType: "bandpass",
  })
  struckBody(context, master, {
    start,
    duration: 0.12,
    volume: volume * 0.75,
    partials: [
      { frequency: body, amplitude: 1, decay: 0.009 },
      { frequency: body * 2.32, amplitude: 0.3, decay: 0.006 },
    ],
  })
  tone(context, master, {
    frequency: low,
    start,
    duration: 0.07,
    volume: volume * 0.32,
    type: "sine",
    attack: 0.002,
    release: 0.04,
  })
}

type KnockOptions = {
  start: number
  base?: number
  volume?: number
  hardness?: number
}

/** A knock on wood: soft contact transient plus a wooden body. */
function knock(context: AudioContext, master: GainNode, options: KnockOptions) {
  const start = Math.max(options.start, context.currentTime)
  const volume = clamp(options.volume ?? 0.16, 0, 0.3)
  const base = options.base ?? 260
  const hardness = clamp(options.hardness ?? 0.7, 0, 1)
  noiseBurst(context, master, {
    start,
    duration: 0.02,
    volume: volume * (0.4 + hardness * 0.6),
    frequency: 500 + hardness * 900,
    q: 0.6,
    filterType: "bandpass",
  })
  struckBody(context, master, {
    start,
    duration: 0.3,
    volume,
    partials: woodBody(base),
  })
}

function playPattern(context: AudioContext, master: GainNode, name: SoundEffectName) {
  const now = context.currentTime
  switch (name) {
    case "click":
      switchClick(context, master, { start: now, cutoff: 2300, body: 1500, low: 190, volume: 0.16 })
      break
    case "toggle-on":
      switchClick(context, master, { start: now, cutoff: 2500, body: 1700, low: 210, volume: 0.18 })
      switchClick(context, master, { start: now + 0.07, cutoff: 2100, body: 1400, low: 180, volume: 0.16 })
      break
    case "toggle-off":
      switchClick(context, master, { start: now, cutoff: 2100, body: 1400, low: 180, volume: 0.17 })
      switchClick(context, master, { start: now + 0.07, cutoff: 1800, body: 1200, low: 160, volume: 0.15 })
      break
    case "send":
      // A paper slide with a soft, sealed thump at the end.
      noiseBurst(context, master, {
        start: now,
        duration: 0.16,
        volume: 0.05,
        frequency: 3200,
        endFrequency: 900,
        q: 0.5,
        filterType: "bandpass",
      })
      tone(context, master, {
        frequency: 150,
        endFrequency: 120,
        start: now + 0.04,
        duration: 0.14,
        volume: 0.06,
        type: "sine",
        attack: 0.008,
        release: 0.07,
      })
      break
    case "typing":
      // A very quiet pen tick on paper.
      noiseBurst(context, master, {
        start: now,
        duration: 0.014,
        volume: 0.025,
        frequency: 3200,
        q: 1.4,
        filterType: "bandpass",
      })
      struckBody(context, master, {
        start: now,
        duration: 0.08,
        volume: 0.02,
        partials: [{ frequency: 1500, amplitude: 1, decay: 0.006 }],
      })
      break
    case "agent-start":
      // A mechanism engages: low knock, then a restrained air and motor hum.
      knock(context, master, { start: now, base: 170, volume: 0.14, hardness: 0.6 })
      tone(context, master, {
        frequency: 95,
        endFrequency: 135,
        start: now + 0.04,
        duration: 0.34,
        volume: 0.06,
        type: "triangle",
        attack: 0.02,
        release: 0.16,
      })
      noiseBurst(context, master, {
        start: now + 0.02,
        duration: 0.26,
        volume: 0.035,
        frequency: 160,
        endFrequency: 380,
        q: 0.5,
        filterType: "lowpass",
      })
      break
    case "agent-end":
      // One struck glass bar that rings out naturally.
      noiseBurst(context, master, {
        start: now,
        duration: 0.012,
        volume: 0.035,
        frequency: 5200,
        q: 1.2,
        filterType: "bandpass",
      })
      struckBody(context, master, {
        start: now,
        duration: 0.9,
        volume: 0.1,
        partials: glassBody(880, 0.45),
      })
      break
    case "goal-start":
      // A heavy latch drops into place.
      knock(context, master, { start: now, base: 120, volume: 0.2, hardness: 0.5 })
      switchClick(context, master, { start: now + 0.09, cutoff: 1600, body: 900, low: 150, volume: 0.18 })
      tone(context, master, {
        frequency: 80,
        start: now + 0.04,
        duration: 0.4,
        volume: 0.07,
        type: "triangle",
        attack: 0.02,
        release: 0.2,
      })
      break
    case "goal-end":
      // Two struck wooden marimba bars, a calm C-G resolution.
      struckBody(context, master, {
        start: now,
        duration: 0.7,
        volume: 0.09,
        partials: marimbaBody(523.25, 0.2),
      })
      struckBody(context, master, {
        start: now + 0.11,
        duration: 0.8,
        volume: 0.08,
        partials: marimbaBody(784, 0.24),
      })
      break
    case "error":
      // Two dull, descending thuds on a wooden block.
      knock(context, master, { start: now, base: 170, volume: 0.16, hardness: 0.35 })
      knock(context, master, { start: now + 0.16, base: 135, volume: 0.14, hardness: 0.3 })
      break
    case "attention":
      // A polite double knock on wood.
      knock(context, master, { start: now, base: 300, volume: 0.13, hardness: 0.7 })
      knock(context, master, { start: now + 0.18, base: 300, volume: 0.13, hardness: 0.7 })
      break
    case "blackboard":
      // Chalk taps a slate board: dry transient plus a short stone ring.
      noiseBurst(context, master, {
        start: now,
        duration: 0.028,
        volume: 0.06,
        frequency: 3600,
        q: 2.2,
        filterType: "bandpass",
      })
      struckBody(context, master, {
        start: now,
        duration: 0.35,
        volume: 0.07,
        partials: stoneBody(920, 0.12),
      })
      break
    case "panel-open":
      noiseBurst(context, master, {
        start: now,
        duration: 0.2,
        volume: 0.055,
        frequency: 950,
        endFrequency: 320,
        q: 0.5,
        filterType: "bandpass",
      })
      knock(context, master, { start: now + 0.14, base: 240, volume: 0.1, hardness: 0.55 })
      break
    case "panel-close":
      noiseBurst(context, master, {
        start: now,
        duration: 0.2,
        volume: 0.06,
        frequency: 750,
        endFrequency: 240,
        q: 0.5,
        filterType: "bandpass",
      })
      knock(context, master, { start: now + 0.12, base: 190, volume: 0.12, hardness: 0.5 })
      break
    case "mode-switch":
      // A rotary knob clicks into a new detent.
      switchClick(context, master, { start: now, cutoff: 2600, body: 1800, low: 210, volume: 0.18 })
      switchClick(context, master, { start: now + 0.07, cutoff: 2000, body: 1300, low: 170, volume: 0.16 })
      break
    case "confirm":
      switchClick(context, master, { start: now, cutoff: 1500, body: 950, low: 170, volume: 0.22 })
      break
    case "cancel":
      switchClick(context, master, { start: now, cutoff: 1900, body: 1200, low: 155, volume: 0.15 })
      break
    case "copy":
      // A crisp card slips out: quick swish closing with a tiny click.
      noiseBurst(context, master, {
        start: now,
        duration: 0.08,
        volume: 0.045,
        frequency: 2800,
        endFrequency: 1100,
        q: 0.7,
        filterType: "bandpass",
      })
      switchClick(context, master, { start: now + 0.07, cutoff: 3000, body: 2000, low: 220, volume: 0.07 })
      break
    case "attach":
      // A paper clip opens: two light metallic clicks.
      switchClick(context, master, { start: now, cutoff: 2800, body: 1900, low: 230, volume: 0.13 })
      switchClick(context, master, { start: now + 0.055, cutoff: 2400, body: 1600, low: 200, volume: 0.11 })
      break
    case "stop":
      // A firm stop switch presses home with a dull body.
      switchClick(context, master, { start: now, cutoff: 1300, body: 800, low: 160, volume: 0.2 })
      tone(context, master, {
        frequency: 140,
        start: now,
        duration: 0.1,
        volume: 0.07,
        type: "sine",
        attack: 0.004,
        release: 0.05,
      })
      break
    case "queue-add":
      // A card drops onto the stack.
      tone(context, master, {
        frequency: 150,
        start: now,
        duration: 0.09,
        volume: 0.05,
        type: "sine",
        attack: 0.005,
        release: 0.05,
      })
      noiseBurst(context, master, {
        start: now,
        duration: 0.05,
        volume: 0.035,
        frequency: 700,
        q: 0.6,
        filterType: "lowpass",
      })
      break
    case "delete":
      // Paper crumples away, then a drawer closes.
      noiseBurst(context, master, {
        start: now,
        duration: 0.2,
        volume: 0.05,
        frequency: 1400,
        endFrequency: 350,
        q: 0.6,
        filterType: "bandpass",
      })
      knock(context, master, { start: now + 0.09, base: 150, volume: 0.12, hardness: 0.45 })
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
  "goal-start": true,
  "goal-end": true,
  error: true,
  attention: true,
  blackboard: true,
  "panel-open": true,
  "panel-close": true,
  "mode-switch": true,
  confirm: true,
  cancel: true,
  copy: true,
  attach: true,
  stop: true,
  "queue-add": true,
  delete: true,
}
