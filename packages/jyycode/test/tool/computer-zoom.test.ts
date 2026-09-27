import { describe, expect, test } from "bun:test"
import type { Observation } from "@/tool/computer/native"
import { createZoom, zoomTargetsUnchanged } from "@/tool/computer/zoom"

function makeObservation(width: number, height: number): Observation {
  return {
    screen: { x: 0, y: 0, width, height },
    image: { width: Math.min(width, 1280), height: Math.min(height, 800) },
    rawImage: { width, height },
    frameID: "fresh-raw-frame",
    capturedAt: 123,
    cursor: { x: 0, y: 0 },
    window: "Test",
    elements: [],
  }
}

async function makePng(width: number, height: number) {
  const photon = await import("@silvia-odwyer/photon-node")
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    pixels[offset] = x & 255
    pixels[offset + 1] = y & 255
    pixels[offset + 2] = ((x >> 8) << 4) | (y >> 8)
    pixels[offset + 3] = 255
  }
  const source = new photon.PhotonImage(pixels, width, height)
  try { return Buffer.from(source.get_bytes()) }
  finally { source.free() }
}

async function expectRawPixel(png: Buffer, x: number, y: number, rawX: number, rawY: number) {
  const photon = await import("@silvia-odwyer/photon-node")
  const image = photon.PhotonImage.new_from_byteslice(png)
  try {
    const offset = (y * image.get_width() + x) * 4
    expect(Array.from(image.get_raw_pixels().subarray(offset, offset + 4))).toEqual([
      rawX & 255,
      rawY & 255,
      ((rawX >> 8) << 4) | (rawY >> 8),
      255,
    ])
  } finally { image.free() }
}

async function changePixel(png: Buffer, x: number, y: number) {
  const photon = await import("@silvia-odwyer/photon-node")
  const source = photon.PhotonImage.new_from_byteslice(png)
  try {
    const width = source.get_width()
    const height = source.get_height()
    const pixels = source.get_raw_pixels()
    pixels[(y * width + x) * 4] ^= 255
    const changed = new photon.PhotonImage(pixels, width, height)
    try { return Buffer.from(changed.get_bytes()) }
    finally { changed.free() }
  } finally { source.free() }
}

describe("computer zoom", () => {
  test("returns an unscaled 800×600 raw-pixel crop with its origin", async () => {
    const raw = await makePng(1000, 700)
    const observation = makeObservation(1000, 700)
    const zoom = await createZoom(raw, observation, { x: 500, y: 350 })

    expect(zoom.observation.view).toEqual({ x: 100, y: 50, width: 800, height: 600 })
    expect(zoom.observation.image).toEqual({ width: 800, height: 600 })
    expect(zoom.observation.rawImage).toEqual({ width: 1000, height: 700 })
    expect(zoom.observation.frameID).toBe("fresh-raw-frame")
    expect(zoom.observation.capturedAt).toBe(123)
    expect(observation).not.toHaveProperty("view")
    await expectRawPixel(zoom.png, 0, 0, 100, 50)
    await expectRawPixel(zoom.png, 400, 300, 500, 350)
    await expectRawPixel(zoom.png, 799, 599, 899, 649)
  })

  test("clamps the crop to the raw screenshot edges", async () => {
    const raw = await makePng(1000, 700)
    const observation = makeObservation(1000, 700)
    const zoom = await createZoom(raw, observation, { x: 999, y: 699 })

    expect(zoom.observation.view).toEqual({ x: 200, y: 100, width: 800, height: 600 })
    await expectRawPixel(zoom.png, 0, 0, 200, 100)
    await expectRawPixel(zoom.png, 799, 599, 999, 699)
  })

  test("keeps small images whole and rejects coordinates or dimensions outside the raw frame", async () => {
    const raw = await makePng(12, 8)
    const observation = makeObservation(12, 8)
    const zoom = await createZoom(raw, observation, { x: 0, y: 0 })
    expect(zoom.observation.view).toEqual({ x: 0, y: 0, width: 12, height: 8 })
    await expectRawPixel(zoom.png, 11, 7, 11, 7)
    await expect(createZoom(raw, observation, { x: 12, y: 0 })).rejects.toThrow("outside")
    await expect(createZoom(raw, { ...observation, rawImage: { width: 13, height: 8 } }, { x: 0, y: 0 }))
      .rejects.toThrow("dimensions")
  })

  test("stops a zoom click when its target pixels move inside the same frame geometry", async () => {
    const raw = await makePng(1000, 700)
    const zoom = await createZoom(raw, makeObservation(1000, 700), { x: 500, y: 350 })
    const point = { x: 400, y: 300 }
    expect(await zoomTargetsUnchanged(zoom.png, raw, zoom.observation.view, [point])).toBe(true)
    expect(await zoomTargetsUnchanged(zoom.png, await changePixel(raw, 500, 350), zoom.observation.view, [point])).toBe(false)
    expect(await zoomTargetsUnchanged(zoom.png, await changePixel(raw, 850, 600), zoom.observation.view, [point])).toBe(true)
  })

  test("checks multiple zoom action points and rejects invalid references", async () => {
    const raw = await makePng(1000, 700)
    const zoom = await createZoom(raw, makeObservation(1000, 700), { x: 999, y: 699 })
    const points = [{ x: 0, y: 0 }, { x: 799, y: 599 }]
    expect(await zoomTargetsUnchanged(zoom.png, raw, zoom.observation.view, points)).toBe(true)
    expect(await zoomTargetsUnchanged(zoom.png, await changePixel(raw, 999, 699), zoom.observation.view, points)).toBe(false)
    expect(await zoomTargetsUnchanged(zoom.png, raw, zoom.observation.view, [])).toBe(false)
    expect(await zoomTargetsUnchanged(zoom.png, raw, zoom.observation.view, [{ x: 800, y: 599 }])).toBe(false)
  })
})
