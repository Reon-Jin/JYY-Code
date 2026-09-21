import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, expect, it, vi } from "vitest"
import { BorderBeam } from "."
import { registerPulseInstance } from "./pulseDriver"

vi.mock("./pulseDriver", () => ({ registerPulseInstance: vi.fn(() => vi.fn()) }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("releases the previous pulse driver on configuration change and unmount", () => {
  const [duration, setDuration] = createSignal(2)
  const view = render(() => <BorderBeam size="pulse-inner" duration={duration()} borderRadius={8} />)
  expect(registerPulseInstance).toHaveBeenCalledTimes(1)
  const first = vi.mocked(registerPulseInstance).mock.results[0]!.value
  setDuration(3)
  expect(first).toHaveBeenCalledTimes(1)
  expect(registerPulseInstance).toHaveBeenCalledTimes(2)
  const second = vi.mocked(registerPulseInstance).mock.results[1]!.value
  view.unmount()
  expect(second).toHaveBeenCalledTimes(1)
})

it("unregisters offscreen pulses and restarts them only when visible", () => {
  let notify!: IntersectionObserverCallback
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  render(() => <BorderBeam size="pulse-inner" borderRadius={8} />)
  const dispose = vi.mocked(registerPulseInstance).mock.results[0]!.value
  notify([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(registerPulseInstance).toHaveBeenCalledTimes(1)
  notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  expect(registerPulseInstance).toHaveBeenCalledTimes(2)
})
