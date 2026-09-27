import path from "node:path"
import { fileURLToPath } from "node:url"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import type { Point, Rect } from "./frame"
import type { Observation } from "./native"

export type ZoomObservation = Observation & { view: Rect }

async function loadPhoton() {
  // The patched package reads this path when its module initializes in a compiled Bun binary.
  ;(globalThis as typeof globalThis & { __JYYCODE_PHOTON_WASM_PATH?: string }).__JYYCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  return import("@silvia-odwyer/photon-node")
}

/** Crop raw screenshot pixels without resizing, retaining the crop's raw-frame origin. */
export async function createZoom(rawPng: Buffer, observation: Observation, center: Point): Promise<{
  png: Buffer
  observation: ZoomObservation
}> {
  const photon = await loadPhoton()
  const source = photon.PhotonImage.new_from_byteslice(rawPng)
  try {
    const sourceWidth = source.get_width()
    const sourceHeight = source.get_height()
    if (!observation.rawImage || observation.rawImage.width !== sourceWidth || observation.rawImage.height !== sourceHeight) {
      throw new Error("Raw screenshot dimensions do not match the observation")
    }
    if (!Number.isSafeInteger(center.x) || !Number.isSafeInteger(center.y) ||
      center.x < 0 || center.y < 0 || center.x >= sourceWidth || center.y >= sourceHeight) {
      throw new Error("Zoom center is outside the raw screenshot")
    }

    const width = Math.min(800, sourceWidth)
    const height = Math.min(600, sourceHeight)
    const x = Math.max(0, Math.min(sourceWidth - width, center.x - Math.floor(width / 2)))
    const y = Math.max(0, Math.min(sourceHeight - height, center.y - Math.floor(height / 2)))
    const cropped = photon.crop(source, x, y, x + width, y + height)
    try {
      return {
        png: Buffer.from(cropped.get_bytes()),
        observation: {
          ...observation,
          image: { width, height },
          view: { x, y, width, height },
        },
      }
    } finally {
      cropped.free()
    }
  } finally {
    source.free()
  }
}

/** Require the pixels near each intended point to still match the zoom the model saw. */
export async function zoomTargetsUnchanged(referencePng: Buffer, rawPng: Buffer, view: Rect, points: readonly Point[]) {
  if (points.length === 0) return false
  const photon = await loadPhoton()
  const reference = photon.PhotonImage.new_from_byteslice(referencePng)
  const raw = photon.PhotonImage.new_from_byteslice(rawPng)
  try {
    const width = raw.get_width()
    const height = raw.get_height()
    if (reference.get_width() !== view.width || reference.get_height() !== view.height ||
      view.x < 0 || view.y < 0 || view.x + view.width > width || view.y + view.height > height) return false
    const oldPixels = reference.get_raw_pixels()
    const newPixels = raw.get_raw_pixels()
    for (const point of points) {
      if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
        point.x < 0 || point.y < 0 || point.x >= view.width || point.y >= view.height) return false
      const left = Math.max(0, point.x - 32)
      const top = Math.max(0, point.y - 32)
      const right = Math.min(view.width, point.x + 33)
      const bottom = Math.min(view.height, point.y + 33)
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const oldOffset = (y * view.width + x) * 4
          const newOffset = ((view.y + y) * width + view.x + x) * 4
          for (let channel = 0; channel < 4; channel++) {
            if (oldPixels[oldOffset + channel] !== newPixels[newOffset + channel]) return false
          }
        }
      }
    }
    return true
  } finally {
    reference.free()
    raw.free()
  }
}

export * as ComputerZoom from "./zoom"
