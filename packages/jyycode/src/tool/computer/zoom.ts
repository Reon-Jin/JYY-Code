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

/** Check the intended control rather than the whole animated desktop. */
export async function visualTargetUnchanged(referencePng: Buffer, currentPng: Buffer, box: Rect, point: Point) {
  const photon = await loadPhoton()
  const reference = photon.PhotonImage.new_from_byteslice(referencePng)
  const current = photon.PhotonImage.new_from_byteslice(currentPng)
  try {
    const width = reference.get_width()
    const height = reference.get_height()
    if (current.get_width() !== width || current.get_height() !== height ||
      ![box.x, box.y, box.width, box.height, point.x, point.y].every(Number.isSafeInteger) ||
      box.width < 2 || box.height < 2 || box.x < 0 || box.y < 0 ||
      box.x + box.width > width || box.y + box.height > height ||
      point.x < box.x || point.y < box.y || point.x >= box.x + box.width || point.y >= box.y + box.height) return false
    const radius = Math.max(8, Math.min(24, Math.floor(Math.min(box.width, box.height) / 4)))
    const left = Math.max(box.x, point.x - radius)
    const top = Math.max(box.y, point.y - radius)
    const right = Math.min(box.x + box.width, point.x + radius + 1)
    const bottom = Math.min(box.y + box.height, point.y + radius + 1)
    const before = reference.get_raw_pixels()
    const after = current.get_raw_pixels()
    let difference = 0
    let changed = 0
    let pixels = 0
    const signed = [0, 0, 0]
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4
      let colorDifference = 0
      for (let channel = 0; channel < 3; channel++) {
        const delta = after[offset + channel]! - before[offset + channel]!
        signed[channel]! += delta
        colorDifference += Math.abs(delta)
      }
      difference += colorDifference
      if (colorDifference > 144) changed++
      pixels++
    }
    // Small lighting and animation changes are normal; a new overlay, moved
    // target, or scene transition changes most of the target patch.
    if (pixels === 0 || changed / pixels > 0.25) return false
    if (difference / (pixels * 3) <= 18) return true
    const tint = signed.map((value) => value / pixels)
    if (tint.some((value) => Math.abs(value) > 35)) return false
    let residual = 0
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        residual += Math.abs(after[offset + channel]! - before[offset + channel]! - tint[channel]!)
      }
    }
    return residual / (pixels * 3) <= 8
  } finally {
    reference.free()
    current.free()
  }
}

export * as ComputerZoom from "./zoom"
