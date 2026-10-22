import { afterEach, describe, expect, it, vi } from "vitest"
import { playSound, resetSoundEngineForTests, setSoundEngineEnabled } from "./sound-engine"

function mockAudio(decode?: () => Promise<AudioBuffer>) {
  const sources: Array<{
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    onended: (() => void) | null
  }> = []
  const context = {
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() })),
    createDynamicsCompressor: vi.fn(() => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createBufferSource: vi.fn(() => {
      const source = {
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(),
        buffer: null,
        onended: null,
      }
      sources.push(source)
      return source
    }),
    decodeAudioData: vi.fn(decode ?? (() => Promise.resolve({} as AudioBuffer))),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  }
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return context
    }),
  )
  const fetcher = vi.fn(() => Promise.resolve(new Response(new ArrayBuffer(8))))
  vi.stubGlobal("fetch", fetcher)
  return { context, sources, fetcher }
}
afterEach(() => {
  resetSoundEngineForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}

describe("recorded sound playback", () => {
  it("preloads and decodes each sample once, reuses buffers and disconnects completed voices", async () => {
    const { context, sources, fetcher } = mockAudio()
    setSoundEngineEnabled(true)
    await settle()
    const loads = fetcher.mock.calls.length
    expect(loads).toBe(14)
    expect(context.decodeAudioData).toHaveBeenCalledTimes(14)
    playSound("click")
    await settle()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.start).toHaveBeenCalledOnce()
    sources[0]!.onended?.()
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce()
    playSound("confirm")
    await settle()
    expect(fetcher).toHaveBeenCalledTimes(loads)
  })

  it("drops pending playback when muted and immediately stops active voices", async () => {
    let resolve!: (buffer: AudioBuffer) => void
    const { sources } = mockAudio(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    playSound("stop")
    await settle()
    setSoundEngineEnabled(false)
    resolve({} as AudioBuffer)
    await settle()
    expect(sources).toHaveLength(0)
    setSoundEngineEnabled(true)
    playSound("error")
    await settle()
    expect(sources).toHaveLength(2)
    setSoundEngineEnabled(false)
    expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true)
  })

  it("bounds overlapping voices and tolerates rejected autoplay", async () => {
    vi.useFakeTimers()
    const { context, sources } = mockAudio()
    for (let i = 0; i < 12; i++) {
      playSound("error")
      await settle()
      vi.advanceTimersByTime(35)
    }
    expect(sources).toHaveLength(24)
    expect(sources.filter((source) => !source.stop.mock.calls.length)).toHaveLength(8)
    context.state = "suspended"
    context.resume.mockRejectedValueOnce(new Error("autoplay denied"))
    playSound("send")
    await settle()
    expect(sources).toHaveLength(24)
  })
})
