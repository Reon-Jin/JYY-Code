import type { ActionCandidate, CandidateSet } from "./candidate"

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const MODEL = "jev-1.13.0"
export type JevDecision =
  | { status: "selected"; candidate: ActionCandidate; confidence: number }
  | { status: "needs_vision"; reason: "no_candidates" | "missing_key" | "low_confidence" | "abstained" | "invalid_response" | "unavailable" }

function validCandidate(candidate: ActionCandidate, frameID: string) {
  if (!candidate.id || candidate.frameID !== frameID) return false
  if (candidate.action === "key") return !!candidate.keys && !candidate.point
  if (!candidate.point || !candidate.box) return false
  const { point, box } = candidate
  if (![point.x, point.y, box.x, box.y, box.width, box.height].every(Number.isSafeInteger)) return false
  if (point.x < box.x || point.y < box.y || point.x >= box.x + box.width || point.y >= box.y + box.height) return false
  if (candidate.action === "drag" && !candidate.endPoint) return false
  if (candidate.action === "type" && candidate.literalText === undefined) return false
  return true
}

export async function selectJev(input: {
  intent: string
  window: string
  candidates: CandidateSet
  apiKey?: string
  endpoint?: string
  timeoutMs?: number
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  signal?: AbortSignal
}): Promise<JevDecision> {
  const { candidates } = input
  if (candidates.items.length === 0) return { status: "needs_vision", reason: "no_candidates" }
  const key = input.apiKey ?? process.env.TYPESAFE_API_KEY
  if (!key) return { status: "needs_vision", reason: "missing_key" }
  if (candidates.items.length > 254 || new Set(candidates.items.map((item) => item.id)).size !== candidates.items.length ||
    candidates.items.some((item) => !validCandidate(item, candidates.frameID))) {
    return { status: "needs_vision", reason: "invalid_response" }
  }
  const criteria: Record<string, Record<string, unknown>> = Object.fromEntries(candidates.items.map((candidate) => [candidate.id,
    { action: candidate.action, target: candidate.label ?? candidate.kind ?? "unlabeled control",
      box: candidate.box ? [candidate.box.x, candidate.box.y, candidate.box.width, candidate.box.height] : undefined,
      point: candidate.point ? [candidate.point.x, candidate.point.y] : undefined,
      sources: candidate.sources }]))
  criteria.NEED_VISION = { action: "abstain", target: "No candidate reliably matches the requested visible action" }
  const body = {
    model: MODEL,
    state: { intent: input.intent, window: input.window, candidates: candidates.items.map((item) => ({ id: item.id, action: item.action, label: item.label, kind: item.kind, point: item.point })), truncated: candidates.truncated },
    questions: { next: { type: "choice", instructions: "Select exactly one currently visible action candidate that matches the intent. Choose NEED_VISION if the target is absent or ambiguous.", criteria } },
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 2_000)
  try {
    const response = await (input.fetcher ?? fetch)(input.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!response.ok) return { status: "needs_vision", reason: "unavailable" }
    const data = await response.json() as { answers?: { next?: { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> } } }
    const answer = data.answers?.next
    if (answer?.type !== "choice" || typeof answer.choice !== "string" ||
      typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 || answer.confidence > 1) return { status: "needs_vision", reason: "invalid_response" }
    if (answer.choice === "NEED_VISION") return { status: "needs_vision", reason: "abstained" }
    const candidate = candidates.items.find((item) => item.id === answer.choice)
    if (!candidate || !answer.probabilities || typeof answer.probabilities[answer.choice] !== "number") {
      return { status: "needs_vision", reason: "invalid_response" }
    }
    if (answer.confidence < 0.65 || answer.probabilities[answer.choice]! < 0.6) {
      return { status: "needs_vision", reason: "low_confidence" }
    }
    return { status: "selected", candidate, confidence: answer.confidence }
  } catch {
    return { status: "needs_vision", reason: "unavailable" }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
  }
}

export * as ComputerJev from "./jev"
