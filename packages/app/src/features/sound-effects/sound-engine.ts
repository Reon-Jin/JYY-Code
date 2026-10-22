import { soundSamples, type SoundSample } from "./sound-samples"

export type SoundEffectName = keyof typeof soundSamples
export function isSoundEffectName(value: unknown): value is SoundEffectName {
  return typeof value === "string" && Object.hasOwn(soundSamples, value)
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode }
type Engine = {
  context: AudioContext
  master: GainNode
  limiter: DynamicsCompressorNode
  buffers: Map<string, Promise<AudioBuffer>>
  voices: Set<Voice>
}
let engine: Engine | undefined
let muted = false
let epoch = 0
const lastPlayedAt = new Map<SoundEffectName, number>()
const variations = new Map<SoundEffectName, number>()
const MAX_VOICES = 8

function getEngine() {
  if (engine) return engine
  if (typeof window === "undefined") return undefined
  const Constructor =
    window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) return undefined
  try {
    const context = new Constructor()
    const master = context.createGain()
    master.gain.value = 0.95
    const limiter = context.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.08
    master.connect(limiter)
    limiter.connect(context.destination)
    return (engine = { context, master, limiter, buffers: new Map(), voices: new Set() })
  } catch {
    return undefined
  }
}

function load(state: Engine, url: string) {
  const existing = state.buffers.get(url)
  if (existing) return existing
  const pending = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error("Sound sample unavailable")
      return response.arrayBuffer()
    })
    .then((bytes) => state.context.decodeAudioData(bytes))
    .catch((error) => {
      if (state.buffers.get(url) === pending) state.buffers.delete(url)
      throw error
    })
  state.buffers.set(url, pending)
  return pending
}

function stopVoice(state: Engine, voice: Voice) {
  voice.source.onended = null
  try {
    voice.source.stop()
  } catch {
    /* Already ended. */
  }
  voice.source.disconnect()
  voice.gain.disconnect()
  state.voices.delete(voice)
}

/** Call within input handlers so suspended WebViews can unlock audio. */
export function unlockSoundEngine() {
  if (muted) return
  const state = getEngine()
  if (state?.context.state === "suspended") void state.context.resume().catch(() => {})
}

export function setSoundEngineEnabled(enabled: boolean) {
  muted = !enabled
  if (!enabled) {
    epoch++
    if (engine) for (const voice of engine.voices) stopVoice(engine, voice)
    return
  }
  const state = getEngine()
  if (!state) return
  // Decode once while enabled. No sound is started before an actual event.
  const urls = new Set(
    Object.values(soundSamples).flatMap((options) =>
      options.flatMap((sequence) => sequence.map((sample) => sample.url)),
    ),
  )
  for (const url of urls) void load(state, url).catch(() => {})
}

export function playSound(name: SoundEffectName) {
  if (muted) return
  const state = getEngine()
  if (!state) return
  const requestedAt = performance.now()
  if (requestedAt - (lastPlayedAt.get(name) ?? -Infinity) < (name === "typing" ? 65 : 28)) return
  lastPlayedAt.set(name, requestedAt)
  const currentEpoch = epoch
  const choices = soundSamples[name] as readonly (readonly SoundSample[])[]
  const variation = variations.get(name) ?? 0
  variations.set(name, variation + 1)
  const sequence = choices[variation % choices.length]!
  const ready = state.context.state === "suspended" ? state.context.resume() : Promise.resolve()
  void Promise.all([ready, Promise.all(sequence.map((sample) => load(state, sample.url)))])
    .then(([, buffers]) => {
      // Decoding or resuming must never replay a stale click or a muted event.
      if (muted || currentEpoch !== epoch || state !== engine || state.context.state !== "running") return
      if (performance.now() - requestedAt > (name === "typing" || name === "click" ? 150 : 1000)) return
      sequence.forEach((sample, index) => {
        while (state.voices.size >= MAX_VOICES) stopVoice(state, state.voices.values().next().value!)
        const source = state.context.createBufferSource()
        const gain = state.context.createGain()
        source.buffer = buffers[index] ?? null
        gain.gain.value = sample.volume
        source.connect(gain)
        gain.connect(state.master)
        const voice = { source, gain }
        state.voices.add(voice)
        source.onended = () => {
          source.disconnect()
          gain.disconnect()
          state.voices.delete(voice)
        }
        source.start(state.context.currentTime + (sample.delay ?? 0))
      })
    })
    .catch(() => {
      /* Missing audio or denied autoplay must not affect the UI. */
    })
}

export function resetSoundEngineForTests() {
  setSoundEngineEnabled(false)
  if (engine) {
    engine.master.disconnect()
    engine.limiter.disconnect()
    void engine.context.close().catch(() => {})
  }
  engine = undefined
  muted = false
  lastPlayedAt.clear()
  variations.clear()
}
