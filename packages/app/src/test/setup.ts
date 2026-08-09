import "@testing-library/jest-dom/vitest"
import { vi } from "vitest"

if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0) as unknown as number,
  })
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  })
}

if (typeof ResizeObserver === "undefined") {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  })
}

// jsdom ships no canvas 2D context; provide a minimal stub so the
// ThinkingOrb canvases render in tests without "Not implemented" noise.
if (typeof HTMLCanvasElement !== "undefined") {
  const ctxStub = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    filter: "none",
  }
  HTMLCanvasElement.prototype.getContext = function () {
    return ctxStub
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
}

// CodeMirror measures text ranges and pointer coordinates that jsdom does not
// implement. Returning empty geometry keeps editor tests deterministic while
// leaving the browser's real layout APIs untouched.
if (typeof Range !== "undefined") {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  })
}
if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => null
}
