/** Geometry and identity of a single screenshot. All visual targets use raw pixels. */
import type { Observation } from "./native"
export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Rect = Point & Size
export type Monitor = { id: string; bounds: Rect; dpiX?: number; dpiY?: number; pixelScaleX?: number; pixelScaleY?: number }
export type WindowIdentity = { id: string; title: string }
export type Tile = Rect & { imageWidth: number; imageHeight: number }

export type Frame = {
  id: string
  capturedAt: number
  screen: Rect
  rawImageSize: Size
  displayImageSize: Size
  monitors: readonly Monitor[]
  foregroundWindow: WindowIdentity
}

function validSize(size: Size, name: string) {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) {
    throw new Error(`${name} must have positive integer dimensions`)
  }
}

export function createFrame(input: Frame): Frame {
  if (!input.id || !Number.isFinite(input.capturedAt) || !input.foregroundWindow?.id) {
    throw new Error("Frame requires an id, capture time, and foreground window id")
  }
  validSize(input.screen, "screen")
  validSize(input.rawImageSize, "raw image")
  validSize(input.displayImageSize, "display image")
  if (!Number.isSafeInteger(input.screen.x) || !Number.isSafeInteger(input.screen.y)) {
    throw new Error("screen origin must be integer desktop coordinates")
  }
  return input
}

function requirePoint(point: Point, size: Size) {
  if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
    point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) {
    throw new Error(`Coordinate (${point.x},${point.y}) is outside ${size.width}×${size.height} image`)
  }
}

export function imagePointToDesktop(frame: Frame, point: Point, space: "raw" | "display" = "raw"): Point {
  const size = space === "raw" ? frame.rawImageSize : frame.displayImageSize
  requirePoint(point, size)
  return {
    x: frame.screen.x + Math.round(point.x * frame.screen.width / size.width),
    y: frame.screen.y + Math.round(point.y * frame.screen.height / size.height),
  }
}

export function desktopPointToImage(frame: Frame, point: Point, space: "raw" | "display" = "raw"): Point {
  const size = space === "raw" ? frame.rawImageSize : frame.displayImageSize
  if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
    point.x < frame.screen.x || point.y < frame.screen.y ||
    point.x >= frame.screen.x + frame.screen.width || point.y >= frame.screen.y + frame.screen.height) {
    throw new Error(`Desktop coordinate (${point.x},${point.y}) is outside the frame screen`)
  }
  return {
    x: Math.min(size.width - 1, Math.round((point.x - frame.screen.x) * size.width / frame.screen.width)),
    y: Math.min(size.height - 1, Math.round((point.y - frame.screen.y) * size.height / frame.screen.height)),
  }
}

function requireTile(frame: Frame, tile: Tile) {
  validSize(tile, "tile")
  validSize({ width: tile.imageWidth, height: tile.imageHeight }, "tile image")
  if (!Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y) || tile.x < 0 || tile.y < 0 ||
    tile.x + tile.width > frame.rawImageSize.width || tile.y + tile.height > frame.rawImageSize.height) {
    throw new Error("Tile is outside the raw image")
  }
}

export function tilePointToImage(frame: Frame, tile: Tile, point: Point): Point {
  requireTile(frame, tile)
  requirePoint(point, { width: tile.imageWidth, height: tile.imageHeight })
  return {
    x: Math.min(frame.rawImageSize.width - 1, tile.x + Math.round(point.x * tile.width / tile.imageWidth)),
    y: Math.min(frame.rawImageSize.height - 1, tile.y + Math.round(point.y * tile.height / tile.imageHeight)),
  }
}

export function imagePointToTile(frame: Frame, tile: Tile, point: Point): Point {
  requireTile(frame, tile)
  requirePoint(point, frame.rawImageSize)
  if (point.x < tile.x || point.y < tile.y || point.x >= tile.x + tile.width || point.y >= tile.y + tile.height) {
    throw new Error("Raw image coordinate is outside the tile")
  }
  return {
    x: Math.min(tile.imageWidth - 1, Math.round((point.x - tile.x) * tile.imageWidth / tile.width)),
    y: Math.min(tile.imageHeight - 1, Math.round((point.y - tile.y) * tile.imageHeight / tile.height)),
  }
}

/** Keeps only the latest observation for each Desktop session. */
export class FrameStore {
  private readonly entries = new Map<string, Observation>()

  constructor(private readonly capacity = 32) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("FrameStore capacity must be positive")
  }

  get(sessionID: string) {
    const frame = this.entries.get(sessionID)
    if (frame) {
      this.entries.delete(sessionID)
      this.entries.set(sessionID, frame)
    }
    return frame
  }

  remember(sessionID: string, observation: Observation) {
    if (!sessionID || !observation.frameID) throw new Error("Cannot remember an unversioned computer frame")
    this.entries.delete(sessionID)
    this.entries.set(sessionID, observation)
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
  }

  forget(sessionID: string) { this.entries.delete(sessionID) }
}

export * as ComputerFrame from "./frame"
