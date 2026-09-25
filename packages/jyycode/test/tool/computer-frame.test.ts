import { describe, expect, test } from "bun:test"
import {
  createFrame,
  desktopPointToImage,
  FrameStore,
  imagePointToDesktop,
  imagePointToTile,
  tilePointToImage,
} from "@/tool/computer/frame"

const screens = [
  { name: "single 100%", screen: { x: 0, y: 0, width: 1920, height: 1080 }, raw: { width: 1920, height: 1080 }, display: { width: 1280, height: 720 }, dpi: 96 },
  { name: "single 150%", screen: { x: 0, y: 0, width: 2560, height: 1440 }, raw: { width: 2560, height: 1440 }, display: { width: 1280, height: 720 }, dpi: 144 },
  { name: "dual 200% with negative origin", screen: { x: -3840, y: -2160, width: 5760, height: 3240 }, raw: { width: 5760, height: 3240 }, display: { width: 1280, height: 720 }, dpi: 192 },
] as const

describe("computer frame geometry", () => {
  test("keeps the latest frame per session and evicts old sessions", () => {
    const store = new FrameStore(2)
    const observation = (frameID: string) => ({
      frameID, screen: { x: 0, y: 0, width: 100, height: 100 }, image: { width: 100, height: 100 },
      cursor: { x: 0, y: 0 }, window: "Synthetic", elements: [],
    })
    store.remember("a", observation("a1"))
    store.remember("b", observation("b1"))
    expect(store.get("a")?.frameID).toBe("a1")
    store.remember("c", observation("c1"))
    expect(store.get("b")).toBeUndefined()
    store.remember("a", observation("a2"))
    expect(store.get("a")?.frameID).toBe("a2")
  })
  for (const fixture of screens) {
    test(`maps raw pixels to desktop and back on ${fixture.name}`, () => {
      const frame = createFrame({
        id: fixture.name,
        capturedAt: 123,
        screen: fixture.screen,
        rawImageSize: fixture.raw,
        displayImageSize: fixture.display,
        monitors: [{ id: "primary", bounds: fixture.screen, dpiX: fixture.dpi, dpiY: fixture.dpi }],
        foregroundWindow: { id: "42", title: "Synthetic app" },
      })
      expect(frame.id).toBe(fixture.name)
      expect(frame.monitors[0]?.dpiX).toBe(fixture.dpi)
      for (const point of [
        { x: 0, y: 0 },
        { x: 17, y: 29 },
        { x: Math.floor(fixture.raw.width / 2), y: Math.floor(fixture.raw.height / 2) },
        { x: fixture.raw.width - 1, y: fixture.raw.height - 1 },
      ]) {
        const desktop = imagePointToDesktop(frame, point, "raw")
        const recovered = desktopPointToImage(frame, desktop, "raw")
        expect(Math.abs(recovered.x - point.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(recovered.y - point.y)).toBeLessThanOrEqual(1)
      }
    })
  }

  test("maps overlapping crop tiles through the original image", () => {
    const frame = createFrame({
      id: "tile",
      capturedAt: 123,
      screen: { x: -1920, y: 0, width: 3840, height: 1080 },
      rawImageSize: { width: 3840, height: 1080 },
      displayImageSize: { width: 1280, height: 360 },
      monitors: [],
      foregroundWindow: { id: "43", title: "Synthetic app" },
    })
    const tile = { x: 1792, y: 64, width: 1024, height: 768, imageWidth: 512, imageHeight: 384 }
    const point = { x: 297, y: 119 }
    const raw = tilePointToImage(frame, tile, point)
    expect(raw).toEqual({ x: 2386, y: 302 })
    const desktop = imagePointToDesktop(frame, raw, "raw")
    expect(desktop).toEqual({ x: 466, y: 302 })
    const recovered = imagePointToTile(frame, tile, raw)
    expect(Math.abs(recovered.x - point.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(recovered.y - point.y)).toBeLessThanOrEqual(1)
  })

  test("rejects out-of-bounds coordinates before input", () => {
    const frame = createFrame({
      id: "bounds", capturedAt: 123,
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
      rawImageSize: { width: 1920, height: 1080 },
      displayImageSize: { width: 1280, height: 720 },
      monitors: [], foregroundWindow: { id: "44", title: "Synthetic app" },
    })
    expect(() => imagePointToDesktop(frame, { x: 1920, y: 0 }, "raw")).toThrow("outside")
    expect(() => imagePointToDesktop(frame, { x: -1, y: 0 }, "raw")).toThrow("outside")
    expect(() => tilePointToImage(frame, { x: 0, y: 0, width: 100, height: 100, imageWidth: 50, imageHeight: 50 }, { x: 50, y: 0 })).toThrow("outside")
  })
})
