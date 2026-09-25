import type { Observation } from "./native"
import type { Frame, Point, Rect } from "./frame"
import type { VisualBox } from "./vision"

export type TargetKind = "button" | "input" | "menu" | "link" | "icon" | "scrollable" | "canvas" | "unknown"
export type TargetSource = "uia" | "ax" | "ocr" | "detector" | "caption"
export type VisualTarget = {
  id: string
  frameID: string
  kind: TargetKind
  box: Rect
  label?: string
  sources: TargetSource[]
  visibility: "visible" | "occluded" | "uncertain"
  confidence: number
  enabled: boolean
  accessibilityIndex?: number
  automationId?: string
}
export type OCRToken = { text: string; box: Rect; confidence: number }
export type FusionResult = { frameID: string; targets: VisualTarget[]; truncated: boolean }

function overlap(a: Rect, b: Rect) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

function area(box: Rect) { return box.width * box.height }
function contains(box: Rect, point: Point) {
  return point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height
}

function kindOf(role: string): TargetKind {
  const value = role.toLowerCase()
  if (value.includes("button") || value.includes("checkbox") || value.includes("radiobutton")) return "button"
  if (value.includes("edit") || value.includes("textfield") || value.includes("textarea") || value.includes("combobox")) return "input"
  if (value.includes("menu") || value.includes("tabitem")) return "menu"
  if (value.includes("link") || value.includes("hyperlink")) return "link"
  if (value.includes("scroll") || value.includes("list")) return "scrollable"
  if (value.includes("canvas") || value.includes("document")) return "canvas"
  return "unknown"
}

function desktopRectToRaw(frame: Frame, box: Rect): Rect | undefined {
  const scaleX = frame.rawImageSize.width / frame.screen.width
  const scaleY = frame.rawImageSize.height / frame.screen.height
  const x1 = Math.max(0, Math.min(frame.rawImageSize.width, Math.round((box.x - frame.screen.x) * scaleX)))
  const y1 = Math.max(0, Math.min(frame.rawImageSize.height, Math.round((box.y - frame.screen.y) * scaleY)))
  const x2 = Math.max(0, Math.min(frame.rawImageSize.width, Math.round((box.x + box.width - frame.screen.x) * scaleX)))
  const y2 = Math.max(0, Math.min(frame.rawImageSize.height, Math.round((box.y + box.height - frame.screen.y) * scaleY)))
  return x2 - x1 >= 2 && y2 - y1 >= 2 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined
}

function validRaw(frame: Frame, box: Rect) {
  return Number.isSafeInteger(box.x) && Number.isSafeInteger(box.y) && Number.isSafeInteger(box.width) && Number.isSafeInteger(box.height) &&
    box.x >= 0 && box.y >= 0 && box.width >= 2 && box.height >= 2 &&
    box.x + box.width <= frame.rawImageSize.width && box.y + box.height <= frame.rawImageSize.height
}

export function fuseTargets(input: {
  frame: Frame
  accessibilitySource: "uia" | "ax"
  elements: Observation["elements"]
  detected: VisualBox[]
  ocr: OCRToken[]
}): FusionResult {
  const { frame } = input
  const targets: VisualTarget[] = []
  const add = (target: Omit<VisualTarget, "id" | "frameID">) => {
    targets.push({ id: `t${targets.length + 1}`, frameID: frame.id, ...target })
  }
  for (const element of input.elements) {
    const box = desktopRectToRaw(frame, element)
    if (!box) continue
    add({
      kind: kindOf(element.role), box,
      label: element.name || element.automationId || undefined,
      sources: [input.accessibilitySource], visibility: "visible", confidence: 0.9,
      enabled: element.enabled, accessibilityIndex: element.index, automationId: element.automationId,
    })
  }
  for (const detection of input.detected) {
    if (!validRaw(frame, detection)) continue
    let best: VisualTarget | undefined
    let bestIoU = 0
    for (const target of targets) {
      if (target.kind === "unknown") continue
      const shared = overlap(target.box, detection)
      const iou = shared / (area(target.box) + area(detection) - shared)
      if (iou > 0.55 && iou > bestIoU) { best = target; bestIoU = iou }
    }
    if (best) {
      best.sources.push("detector")
      best.confidence = Math.max(best.confidence, detection.confidence)
    } else {
      add({ kind: "icon", box: { x: detection.x, y: detection.y, width: detection.width, height: detection.height },
        sources: ["detector"], visibility: "visible", confidence: detection.confidence, enabled: true })
    }
  }
  for (const token of input.ocr) {
    if (!validRaw(frame, token.box) || !token.text.trim()) continue
    const center = { x: token.box.x + token.box.width / 2, y: token.box.y + token.box.height / 2 }
    const matches = targets.filter((target) => target.kind !== "unknown" && target.kind !== "input" && contains(target.box, center) &&
      overlap(target.box, token.box) / area(token.box) >= 0.6)
    matches.sort((a, b) => area(a.box) - area(b.box))
    const target = matches[0]
    if (target && (!target.label || target.label === token.text.trim())) {
      target.label ??= token.text.trim()
      target.sources.push("ocr")
      target.confidence = Math.max(target.confidence, token.confidence)
    } else if (!target) {
      add({ kind: "unknown", box: token.box, label: token.text.trim(), sources: ["ocr"],
        visibility: "uncertain", confidence: token.confidence, enabled: false })
    }
  }
  return { frameID: frame.id, targets, truncated: input.elements.length >= 160 || input.detected.length >= 512 }
}

export * as ComputerFuse from "./fuse"
