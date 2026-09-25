import { buildCandidates, type ActionCandidate, type CandidateAction } from "./candidate"
import { createFrame, imagePointToDesktop, type Frame, type Rect } from "./frame"
import { fuseTargets, type OCRToken, type VisualTarget } from "./fuse"
import { selectJev, type JevDecision } from "./jev"
import { runNative, type Action, type Observation, type Step } from "./native"
import { LocalVisualParser, parseTiled, type VisualBox, type VisualFrame, type VisualParser } from "./vision"
import { LocalOCRParser } from "./ocr"

export type ChooseInput = {
  intent: string
  literalText?: string
  keys?: string
  allowedActions?: readonly CandidateAction[]
  resolution?: "standard" | "high"
}
export type NativeResult = Awaited<ReturnType<typeof runNative>>
export type ChooseResult = {
  status: "executed" | "needs_vision"
  reasonCode: string
  observation: Observation
  png: Buffer
  selected?: ActionCandidate
  confidence?: number
}
export type ChooseDependencies = {
  native?: typeof runNative
  parser?: VisualParser
  ocr?: (frame: VisualFrame, signal?: AbortSignal, region?: Rect) => Promise<OCRToken[]>
  select?: typeof selectJev
}

const localParser = new LocalVisualParser()
const localOCR = new LocalOCRParser()

/** Start GPU model loading in the background when Desktop enables computer control. */
export function prewarmComputerVision() {
  if (process.env.JYYCODE_COMPUTER_VISION_MODEL) {
    void localParser.health()
    void localOCR.health()
  }
}

function frameOf(observation: Observation): Frame | undefined {
  if (!observation.frameID || !observation.windowID || !observation.rawImage) return undefined
  return createFrame({
    id: observation.frameID,
    capturedAt: observation.capturedAt ?? Date.now(),
    screen: observation.screen,
    rawImageSize: observation.rawImage,
    displayImageSize: observation.image,
    monitors: observation.monitors ?? [],
    foregroundWindow: { id: observation.windowID, title: observation.window },
  })
}

function uniqueAccessibilityMatch(targets: VisualTarget[], intent: string) {
  const lowered = intent.toLocaleLowerCase()
  const matched = targets.filter((target) => target.enabled && target.label &&
    (target.sources.includes("uia") || target.sources.includes("ax")) &&
    (lowered.includes(target.label.toLocaleLowerCase()) ||
      target.label.toLocaleLowerCase().split(/[\s\/、,，]+/).some((token) => token.length > 1 && lowered.includes(token))))
  return matched.length === 1 ? matched : undefined
}

function sameFrameScreen(a: Frame, b: Frame) {
  return a.foregroundWindow.id === b.foregroundWindow.id &&
    a.screen.x === b.screen.x && a.screen.y === b.screen.y &&
    a.screen.width === b.screen.width && a.screen.height === b.screen.height &&
    a.rawImageSize.width === b.rawImageSize.width && a.rawImageSize.height === b.rawImageSize.height &&
    JSON.stringify(a.monitors.map((monitor) => [monitor.id, monitor.bounds, monitor.dpiX, monitor.dpiY, monitor.pixelScaleX, monitor.pixelScaleY])) ===
    JSON.stringify(b.monitors.map((monitor) => [monitor.id, monitor.bounds, monitor.dpiX, monitor.dpiY, monitor.pixelScaleX, monitor.pixelScaleY]))
}

function regionFromIntent(frame: VisualFrame, intent: string): Rect | undefined {
  const top = /上|top/i.test(intent)
  const bottom = /下|bottom/i.test(intent)
  const left = /左|left/i.test(intent)
  const right = /右|right/i.test(intent)
  if ((!top && !bottom) || (!left && !right)) return undefined
  const width = Math.ceil(frame.width / 2)
  const height = Math.ceil(frame.height / 2)
  return { x: right ? frame.width - width : 0, y: bottom ? frame.height - height : 0, width, height }
}

export function candidateToNative(candidate: ActionCandidate, frame: Frame): Action {
  if (candidate.frameID !== frame.id) throw new Error("Candidate belongs to an old frame")
  const expectWindow = frame.foregroundWindow.id
  const point = candidate.point ? imagePointToDesktop(frame, candidate.point, "raw") : undefined
  if (candidate.action === "key") {
    if (!candidate.keys) throw new Error("Key candidate has no keys")
    return { action: "key", keys: candidate.keys, expectWindow }
  }
  if (!point) throw new Error("Candidate has no grounded point")
  if (!candidate.box || !candidate.point || candidate.point.x < candidate.box.x || candidate.point.y < candidate.box.y ||
    candidate.point.x >= candidate.box.x + candidate.box.width || candidate.point.y >= candidate.box.y + candidate.box.height) {
    throw new Error("Candidate point is outside its visual target")
  }
  const expectTarget = candidate.sources?.some((source) => source === "uia" || source === "ax")
    ? (() => {
        const top = imagePointToDesktop(frame, { x: candidate.box!.x, y: candidate.box!.y }, "raw")
        const bottom = imagePointToDesktop(frame, {
          x: candidate.box!.x + candidate.box!.width - 1,
          y: candidate.box!.y + candidate.box!.height - 1,
        }, "raw")
        return { name: candidate.label, automationId: candidate.automationId, kind: candidate.kind ?? "unknown",
          x: top.x, y: top.y, width: Math.max(1, bottom.x - top.x + 1), height: Math.max(1, bottom.y - top.y + 1) }
      })()
    : undefined
  if (candidate.action === "click") return { action: "click", ...point, expectWindow, expectTarget }
  if (candidate.action === "double_click") return { action: "click", ...point, double: true, expectWindow, expectTarget }
  if (candidate.action === "right_click") return { action: "click", ...point, button: "right", expectWindow, expectTarget }
  if (candidate.action === "scroll") return { action: "scroll", ...point, direction: candidate.direction ?? "down", amount: candidate.amount ?? 1, expectWindow, expectTarget }
  if (candidate.action === "drag") {
    if (!candidate.endPoint) throw new Error("Drag candidate has no endpoint")
    const end = imagePointToDesktop(frame, candidate.endPoint, "raw")
    return { action: "drag", ...point, toX: end.x, toY: end.y, expectWindow, expectTarget }
  }
  if (candidate.action === "type") {
    if (candidate.literalText === undefined) throw new Error("Type candidate has no literal text")
    const steps: Step[] = [
      { action: "click", ...point, expectWindow, expectTarget },
      { action: "type", text: candidate.literalText, expectWindow },
    ]
    return { action: "batch", steps }
  }
  throw new Error("Unsupported candidate action")
}

export async function runChoose(input: ChooseInput, signal?: AbortSignal, deps: ChooseDependencies = {}): Promise<ChooseResult> {
  if (!input.intent.trim() || input.intent.length > 500) throw new Error("choose intent must contain 1 to 500 characters")
  const native = deps.native ?? runNative
  const parser = deps.parser ?? localParser
  const select = deps.select ?? selectJev
  const observed = await native({ action: "observe", includeElements: true, captureRaw: true, resolution: input.resolution }, signal)
  const frame = frameOf(observed.observation)
  const fallback = (reasonCode: string, result: NativeResult = observed): ChooseResult => ({
    status: "needs_vision", reasonCode, observation: result.observation, png: result.png,
  })
  if (!frame || !observed.rawPng) return fallback("raw_frame_unavailable")
  const source = process.platform === "darwin" ? "ax" : "uia"
  let fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements, detected: [], ocr: [] })
  let relevant = uniqueAccessibilityMatch(fusion.targets, input.intent)
  let visualFrame: VisualFrame | undefined
  let detections: VisualBox[] = []
  let ocrTokens: OCRToken[] = []
  const ocrProvider = deps.ocr ?? (localOCR.isReady() ? (value: VisualFrame, nextSignal?: AbortSignal, region?: Rect) => localOCR.parse(value, nextSignal, region) : undefined)
  if (!relevant) {
    const ready = "isReady" in parser && typeof parser.isReady === "function" ? parser.isReady() : true
    if (!ready) {
      prewarmComputerVision()
      return fallback("vision_warming")
    }
    visualFrame = { id: frame.id, png: observed.rawPng, width: frame.rawImageSize.width, height: frame.rawImageSize.height }
    let detected: Awaited<ReturnType<VisualParser["parse"]>>
    try { detected = await parser.parse(visualFrame, undefined, signal) }
    catch { return fallback("vision_unavailable") }
    detections = detected.boxes
    fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements,
      detected: detections, ocr: [] })
    relevant = undefined
  }
  let candidates = buildCandidates({
    frame, intent: input.intent, targets: relevant ?? fusion.targets,
    allowedActions: input.allowedActions ?? ["click", "double_click", "right_click", "scroll", "type", "key", "drag"],
    literalText: input.literalText, keys: input.keys, sourceTruncated: fusion.truncated,
  })
  let decision: JevDecision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, signal })
  if (decision.status === "needs_vision" && ["abstained", "low_confidence", "no_candidates"].includes(decision.reason) &&
    visualFrame && ocrProvider) {
    try { ocrTokens = await ocrProvider(visualFrame, signal, regionFromIntent(visualFrame, input.intent)) }
    catch { ocrTokens = [] }
    if (ocrTokens.length > 0) {
      fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements,
        detected: detections, ocr: ocrTokens })
      candidates = buildCandidates({ frame, intent: input.intent, targets: fusion.targets,
        allowedActions: input.allowedActions ?? ["click", "double_click", "right_click", "scroll", "type", "key", "drag"],
        literalText: input.literalText, keys: input.keys, sourceTruncated: fusion.truncated })
      decision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, signal })
    }
  }
  if (decision.status === "needs_vision" && ["abstained", "low_confidence", "no_candidates"].includes(decision.reason) &&
    visualFrame && (visualFrame.width > 1280 || visualFrame.height > 1280)) {
    try {
      const tiled = await parseTiled(parser, visualFrame, signal)
      fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements,
        detected: tiled.boxes, ocr: ocrTokens })
      candidates = buildCandidates({ frame, intent: input.intent, targets: fusion.targets,
        allowedActions: input.allowedActions ?? ["click", "double_click", "right_click", "scroll", "type", "key", "drag"],
        literalText: input.literalText, keys: input.keys, sourceTruncated: fusion.truncated })
      decision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, signal })
    } catch { return fallback("vision_unavailable") }
  }
  if (decision.status !== "selected") return fallback(decision.reason)
  const selected = candidates.items.find((item) => item.id === decision.candidate.id && item.frameID === frame.id)
  if (!selected) return fallback("invalid_candidate")
  const action = candidateToNative(selected, frame)
  const nativeTargetGuard = process.platform === "win32" && selected.sources?.includes("uia") &&
    action.action !== "key" && (action.action !== "batch" || action.steps[0]?.expectTarget)
  if (!nativeTargetGuard) {
    const guard = await native({ action: "observe", includeElements: false, captureRaw: true, resolution: input.resolution }, signal)
    const guardFrame = frameOf(guard.observation)
    if (!guardFrame || !guard.rawPng || !sameFrameScreen(frame, guardFrame) || !observed.rawPng.equals(guard.rawPng)) {
      return fallback("stale_frame", guard)
    }
  }
  try {
    const result = await native({ ...action, resolution: input.resolution }, signal)
    return { status: "executed", reasonCode: "selected", observation: result.observation,
      png: result.png, selected, confidence: decision.confidence }
  } catch (error) {
    if (!(error instanceof Error) ||
      (!error.message.includes("Foreground window changed") && !error.message.includes("Target at coordinate"))) throw error
    const fresh = await native({ action: "observe", includeElements: true, resolution: input.resolution }, signal)
    return fallback(error.message.includes("Target at coordinate") ? "target_changed" : "foreground_changed", fresh)
  }
}

export * as ComputerChoose from "./choose"
