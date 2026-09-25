import type { Frame, Point, Rect } from "./frame"
import type { VisualTarget } from "./fuse"

export type CandidateAction = "click" | "double_click" | "right_click" | "scroll" | "type" | "key" | "drag"
export type ActionCandidate = {
  id: string
  frameID: string
  action: CandidateAction
  targetID?: string
  label?: string
  kind?: VisualTarget["kind"]
  box?: Rect
  point?: Point
  endPoint?: Point
  literalText?: string
  keys?: string
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  sources?: VisualTarget["sources"]
  automationId?: string
}
export type CandidateSet = { frameID: string; items: ActionCandidate[]; truncated: boolean; total: number }

function contains(box: Rect, point: Point) {
  return point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height
}

export function safePoint(target: VisualTarget, others: readonly VisualTarget[]): Point | undefined {
  const box = target.box
  if (box.width < 4 || box.height < 4 || target.visibility !== "visible") return undefined
  const xs = [0.5, 0.3, 0.7]
  const ys = [0.5, 0.3, 0.7]
  for (const fy of ys) for (const fx of xs) {
    const point = { x: Math.floor(box.x + box.width * fx), y: Math.floor(box.y + box.height * fy) }
    if (!contains(box, point)) continue
    if (others.some((other) => other.id !== target.id && other.kind !== "unknown" &&
      other.box.width * other.box.height < box.width * box.height && contains(other.box, point))) continue
    return point
  }
  return undefined
}

function legal(action: CandidateAction, target: VisualTarget, literalText?: string, endPoint?: Point) {
  if (!target.enabled || target.kind === "unknown" || target.visibility !== "visible") return false
  if (action === "click" || action === "double_click" || action === "right_click") {
    return ["button", "input", "menu", "link", "icon", "canvas"].includes(target.kind)
  }
  if (action === "type") return target.kind === "input" && literalText !== undefined
  if (action === "scroll") return target.kind === "scrollable" || target.kind === "canvas"
  if (action === "drag") return !!endPoint && target.kind === "canvas"
  return false
}

function relevance(intent: string, target: VisualTarget, frame: Frame) {
  const text = intent.toLocaleLowerCase()
  const label = (target.label ?? "").toLocaleLowerCase()
  let score = target.confidence
  if (label && (text.includes(label) || label.includes(text))) score += 10
  for (const token of label.split(/[\s\/、,，]+/).filter((item) => item.length > 1)) if (text.includes(token)) score += 2
  if (target.sources.includes("uia") || target.sources.includes("ax")) score += 0.2
  const cx = target.box.x + target.box.width / 2
  const cy = target.box.y + target.box.height / 2
  if (/右上|右下|右侧|右边|right/.test(text)) score += cx >= frame.rawImageSize.width / 2 ? 3 : -3
  if (/左上|左下|左侧|左边|left/.test(text)) score += cx < frame.rawImageSize.width / 2 ? 3 : -3
  if (/左上|右上|顶部|上方|top/.test(text)) score += cy < frame.rawImageSize.height / 2 ? 3 : -3
  if (/左下|右下|底部|下方|bottom/.test(text)) score += cy >= frame.rawImageSize.height / 2 ? 3 : -3
  return score
}

export function buildCandidates(input: {
  frame: Frame
  intent: string
  targets: VisualTarget[]
  allowedActions: readonly CandidateAction[]
  literalText?: string
  keys?: string
  endPoint?: Point
  limit?: number
  sourceTruncated?: boolean
}): CandidateSet {
  const limit = Math.max(1, Math.min(254, input.limit ?? 64))
  const items: Array<ActionCandidate & { rank: number }> = []
  for (const target of input.targets) {
    if (target.frameID !== input.frame.id) continue
    const point = safePoint(target, input.targets)
    if (!point) continue
    for (const action of input.allowedActions) {
      if (!legal(action, target, input.literalText, input.endPoint)) continue
      const direction = /上|up/i.test(input.intent) ? "up" : /左|left/i.test(input.intent) ? "left" : /右|right/i.test(input.intent) ? "right" : "down"
      items.push({
        id: "", frameID: input.frame.id, action, targetID: target.id, label: target.label,
        kind: target.kind, box: target.box, point,
        endPoint: action === "drag" ? input.endPoint : undefined,
        literalText: action === "type" ? input.literalText : undefined,
        direction: action === "scroll" ? direction : undefined,
        amount: action === "scroll" ? 1 : undefined,
        sources: target.sources,
        automationId: target.automationId,
        rank: relevance(input.intent, target, input.frame),
      })
    }
  }
  if (input.allowedActions.includes("key") && input.keys) {
    items.push({ id: "", frameID: input.frame.id, action: "key", keys: input.keys, rank: 1 })
  }
  items.sort((a, b) => b.rank - a.rank || (a.targetID ?? "").localeCompare(b.targetID ?? ""))
  const selected = items.slice(0, limit).map(({ rank: _rank, ...item }, index) => ({ ...item, id: `c${index + 1}` }))
  return { frameID: input.frame.id, items: selected, truncated: !!input.sourceTruncated || items.length > limit, total: items.length }
}

export * as ComputerCandidate from "./candidate"
