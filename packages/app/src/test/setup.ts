import "@testing-library/jest-dom/vitest"

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
