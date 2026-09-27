import { buildCandidates, type ActionCandidate, type CandidateAction } from "./candidate"
import { createFrame, imagePointToDesktop, type Frame, type Rect } from "./frame"
import { fuseTargets, type OCRToken, type VisualTarget } from "./fuse"
import { selectJev, type JevDecision } from "./jev"
import { runNative, type Action, type Observation, type Step } from "./native"
import { LocalVisualParser, parseTiled, type VisualBox, type VisualFrame, type VisualParser } from "./vision"
import { LocalOCRParser } from "./ocr"
import { visualTargetUnchanged } from "./zoom"

export type ChooseInput = {
  intent: string
  apiKey?: string
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
export async function stopChooseWorkers() {
  await Promise.all([localParser.close(), localOCR.close()])
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
  // Only relative corner words are considered. Numeric screenshot coordinates
  // remain untouched and OCR boxes are mapped back to raw pixels afterward.
  const top = /上|top/i.test(intent)
  const bottom = /下|bottom/i.test(intent)
  const left = /左|left/i.test(intent)
  const right = /右|right/i.test(intent)
  if ((!top && !bottom) || (!left && !right)) return undefined
  const width = Math.ceil(frame.width / 2)
  const height = Math.ceil(frame.height / 2)
  return { x: right ? frame.width - width : 0, y: bottom ? frame.height - height : 0, width, height }
}

export function scaleOCRTokensToRaw(tokens: readonly OCRToken[], display: { width: number; height: number },
  raw: { width: number; height: number }): OCRToken[] {
  const scaleX = raw.width / display.width
  const scaleY = raw.height / display.height
  return tokens.map((token) => {
    const x = Math.floor(token.box.x * scaleX)
    const y = Math.floor(token.box.y * scaleY)
    return { ...token, box: { x, y,
      width: Math.min(raw.width - x, Math.max(2, Math.ceil((token.box.x + token.box.width) * scaleX) - x)),
      height: Math.min(raw.height - y, Math.max(2, Math.ceil((token.box.y + token.box.height) * scaleY) - y)) } }
  })
}

function hasExplicitPosition(intent: string) {
  return /右上|右下|左上|左下|右侧|左侧|顶部|底部|上方|下方|中央|中心|top|bottom|left|right|center|第[一二三四五六七八九十\d]+个/i.test(intent)
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
  const keyOnly = input.keys !== undefined && input.allowedActions?.length === 1 && input.allowedActions[0] === "key"
  // Jev needs some UIA candidates, but a deep tree walk can consume the entire
  // latency budget before vision or the action itself starts.
  const observed = await native({ action: "observe", includeElements: !keyOnly, captureRaw: !keyOnly,
    uiScanBudgetMs: keyOnly ? undefined : 350, resolution: input.resolution }, signal)
  const frame = frameOf(observed.observation)
  const fallback = (reasonCode: string, result: NativeResult = observed): ChooseResult => ({
    status: "needs_vision", reasonCode, observation: result.observation, png: result.png,
  })
  if (!frame || (!keyOnly && !observed.rawPng)) return fallback("raw_frame_unavailable")
  const source = process.platform === "darwin" ? "ax" : "uia"
  let fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements, detected: [], ocr: [] })
  let relevant = uniqueAccessibilityMatch(fusion.targets, input.intent)
  let visualFrame: VisualFrame | undefined
  let detections: VisualBox[] = []
  let ocrTokens: OCRToken[] = []
  let usedTiled = false
  let warmOCR = false
  if (!relevant && !keyOnly) {
    if (!observed.rawPng) return fallback("raw_frame_unavailable")
    const ready = "isReady" in parser && typeof parser.isReady === "function" ? parser.isReady() : true
    if (!ready) {
      void parser.health().catch(() => undefined)
      return fallback("vision_warming")
    }
    visualFrame = { id: frame.id, png: observed.rawPng, width: frame.rawImageSize.width, height: frame.rawImageSize.height }
    let detected: Awaited<ReturnType<VisualParser["parse"]>>
    usedTiled = input.resolution === "high" && (visualFrame.width > 1280 || visualFrame.height > 1280)
    // Standard mode uses a fast whole-screen or corner crop; high mode preserves small targets with tiles.
    try { detected = usedTiled
      ? await parseTiled(parser, visualFrame, signal)
      : await parser.parse(visualFrame, regionFromIntent(visualFrame, input.intent), signal) }
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
  let decision: JevDecision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, apiKey: input.apiKey, signal })
  if (decision.status === "needs_vision" && ["abstained", "low_confidence", "no_candidates"].includes(decision.reason) &&
    visualFrame) {
    // OCR is an expensive fallback. Starting EasyOCR can take several seconds;
    // let this call return promptly while it warms, and run it on the already
    // downscaled observation once ready. Detector boxes remain in raw pixels.
    const ocrProvider = deps.ocr ?? (localOCR.isReady()
      ? async (_value: VisualFrame, nextSignal?: AbortSignal) => {
          const display = { id: frame.id, png: observed.png,
            width: frame.displayImageSize.width, height: frame.displayImageSize.height }
          const tokens = await localOCR.parse(display, nextSignal, regionFromIntent(display, input.intent))
          return scaleOCRTokensToRaw(tokens, display, frame.rawImageSize)
        }
      : undefined)
    if (!deps.ocr && !ocrProvider) warmOCR = true
    try { ocrTokens = ocrProvider ? await ocrProvider(visualFrame, signal, regionFromIntent(visualFrame, input.intent)) : [] }
    catch { ocrTokens = [] }
    if (ocrTokens.length > 0) {
      fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements,
        detected: detections, ocr: ocrTokens })
      candidates = buildCandidates({ frame, intent: input.intent, targets: fusion.targets,
        allowedActions: input.allowedActions ?? ["click", "double_click", "right_click", "scroll", "type", "key", "drag"],
        literalText: input.literalText, keys: input.keys, sourceTruncated: fusion.truncated })
      decision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, apiKey: input.apiKey, signal })
    }
  }
  if (decision.status === "needs_vision" && ["abstained", "low_confidence", "no_candidates"].includes(decision.reason) &&
    !usedTiled && visualFrame && (visualFrame.width > 1280 || visualFrame.height > 1280)) {
    try {
      const tiled = await parseTiled(parser, visualFrame, signal)
      fusion = fuseTargets({ frame, accessibilitySource: source, elements: observed.observation.elements,
        detected: tiled.boxes, ocr: ocrTokens })
      candidates = buildCandidates({ frame, intent: input.intent, targets: fusion.targets,
        allowedActions: input.allowedActions ?? ["click", "double_click", "right_click", "scroll", "type", "key", "drag"],
        literalText: input.literalText, keys: input.keys, sourceTruncated: fusion.truncated })
      decision = await select({ intent: input.intent, window: frame.foregroundWindow.title, candidates, apiKey: input.apiKey, signal })
    } catch { return fallback("vision_unavailable") }
  }
  if (decision.status !== "selected") {
    // Do not compete with tiled detection for CPU on this action.
    if (warmOCR) void localOCR.health().catch(() => undefined)
    return fallback(decision.reason)
  }
  const selected = candidates.items.find((item) => item.id === decision.candidate.id && item.frameID === frame.id)
  if (!selected) return fallback("invalid_candidate")
  // Jev sees JSON rather than pixels. A nameless icon cannot be matched to a semantic intent from coordinates alone.
  if (selected.action !== "key" && !selected.label && !hasExplicitPosition(input.intent)) return fallback("unlabeled_target")
  const action = candidateToNative(selected, frame)
  const nativeTargetGuard = source === "uia" && selected.sources?.includes("uia") &&
    action.action !== "key" && (action.action !== "batch" || action.steps[0]?.expectTarget)
  if (action.action !== "key" && !nativeTargetGuard) {
    if (!observed.rawPng) return fallback("raw_frame_unavailable")
    const guard = await native({ action: "observe", includeElements: false, captureRaw: true, resolution: input.resolution }, signal)
    const guardFrame = frameOf(guard.observation)
    if (!guardFrame || !guard.rawPng || !sameFrameScreen(frame, guardFrame) ||
      !selected.box || !selected.point ||
      !await visualTargetUnchanged(observed.rawPng, guard.rawPng, selected.box, selected.point).catch(() => false)) {
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
