import { secretFindings } from "@jyycode-ai/http-recorder"

export type ReplayNormalizationOptions = {
  workspaceRoots?: readonly string[]
  tempRoots?: readonly string[]
}

type TokenKind =
  | "session"
  | "call"
  | "step"
  | "message"
  | "event"
  | "request"
  | "timestamp"
  | "port"
  | "pid"
  | "duration"
  | "tokens"
  | "cost"
  | "id"

type NormalizationState = {
  readonly options: ReplayNormalizationOptions
  readonly values: Map<string, string>
  readonly counters: Map<TokenKind, number>
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i
const ID_PREFIX = /^(?:session|sess|call|toolu|step|msg|message|evt|event|req|request|proc|process)[_-][A-Za-z0-9_-]+$/i
const TIMESTAMP_KEY = /(?:timestamp|createdat|updatedat|startedat|endedat|finishedat|occurredat)$/i
const DURATION_KEY = /(?:duration|elapsed|latency|timeout|waitms|durationms)$/i
const TOKEN_KEY = /(?:tokens?|inputtokens|outputtokens|prompttokens|completiontokens)$/i
const COST_KEY = /(?:cost|price)$/i
const PORT_KEY = /(?:^|[_.-])port$/i
const PID_KEY = /(?:^|[_.-])(?:pid|processid)$/i
const PATH_KEY = /(?:path|file|cwd|directory|workspace|root|filename|command)$/i

const asPosix = (value: string) => value.replaceAll("\\", "/")

function pathToken(value: string, options: ReplayNormalizationOptions) {
  let result = asPosix(value)
  const roots = [...(options.workspaceRoots ?? []), ...(options.tempRoots ?? [])]
    .map(asPosix)
    .toSorted((a, b) => b.length - a.length)
  for (const root of roots) {
    const normalizedRoot = root.replace(/\/$/, "")
    if (result === normalizedRoot) return "<workspace>"
    if (result.startsWith(`${normalizedRoot}/`)) return `<workspace>${result.slice(normalizedRoot.length)}`
  }

  result = result.replace(/^(?:[A-Za-z]:)?\/Users\/[^/]+\/AppData\/Local\/Temp\/[^/]+/i, "<workspace>")
  result = result.replace(/^(?:[A-Za-z]:)?\/tmp\/[^/]+/i, "<workspace>")
  result = result.replace(/^\/var\/folders\/[^/]+\/[^/]+\/T\/[^/]+/i, "<workspace>")
  return result
}

function token(state: NormalizationState, kind: TokenKind, value: string) {
  const existing = state.values.get(value)
  if (existing) return existing
  const next = (state.counters.get(kind) ?? 0) + 1
  state.counters.set(kind, next)
  const result = `<${kind}-${next}>`
  state.values.set(value, result)
  return result
}

function idKind(key: string, value: string): TokenKind | undefined {
  const lower = key.toLowerCase()
  if (lower.includes("session")) return "session"
  if (lower.includes("toolcall") || lower.includes("call")) return "call"
  if (lower.includes("step")) return "step"
  if (lower.includes("message") || lower === "msgid") return "message"
  if (lower.includes("event") || lower === "eventid") return "event"
  if (lower.includes("request") || lower === "reqid") return "request"
  if (UUID.test(value) || ULID.test(value) || ID_PREFIX.test(value)) {
    if (/^(?:session|sess)[_-]/i.test(value)) return "session"
    if (/^(?:call|toolu)[_-]/i.test(value)) return "call"
    if (/^step[_-]/i.test(value)) return "step"
    if (/^(?:msg|message)[_-]/i.test(value)) return "message"
    if (/^(?:evt|event)[_-]/i.test(value)) return "event"
    if (/^(?:req|request)[_-]/i.test(value)) return "request"
    return "id"
  }
  return undefined
}

function normalizeString(value: string, key: string, state: NormalizationState): string {
  if (value.startsWith("<") && value.endsWith(">")) return value
  if (ABSOLUTE_PATH.test(value) && (PATH_KEY.test(key) || value === pathToken(value, state.options))) {
    return pathToken(value, state.options)
  }

  if (key.toLowerCase() === "url" || key.toLowerCase().endsWith("url")) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
      return asPosix(value).replace(/:(\d+)(?=\/|$)/, (_, port: string) => `:${token(state, "port", port)}`)
    }
  }

  if (TIMESTAMP_KEY.test(key) && !Number.isNaN(Date.parse(value))) return token(state, "timestamp", value)
  const kind = idKind(key, value)
  return kind ? token(state, kind, value) : value
}

function normalizeValue(value: unknown, key: string, state: NormalizationState): unknown {
  if (typeof value === "string") return normalizeString(value, key, state)
  if (typeof value === "number" && Number.isFinite(value)) {
    if (PORT_KEY.test(key)) return token(state, "port", String(value))
    if (PID_KEY.test(key)) return token(state, "pid", String(value))
    if (DURATION_KEY.test(key)) return token(state, "duration", String(value))
    if (TOKEN_KEY.test(key)) return token(state, "tokens", String(value))
    if (COST_KEY.test(key)) return token(state, "cost", String(value))
    if (TIMESTAMP_KEY.test(key)) return token(state, "timestamp", String(value))
    return value
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, key, state))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, normalizeValue(child, childKey, state)]),
    )
  }
  return value
}

export function normalizeFixture(value: unknown, options: ReplayNormalizationOptions = {}): any {
  return normalizeValue(value, "", { options, values: new Map(), counters: new Map() })
}

function valueFreeFindings(value: unknown, path = ""): ReadonlyArray<{ path: string; reason: string }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => valueFreeFindings(item, `${path}[${index}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key
    const lower = key.toLowerCase().replaceAll("-", "_")
    const keyFinding =
      /^(?:authorization|cookie|set_cookie|api_key|apikey|access_token|refresh_token|password|secret|private_key)$/.test(
        lower,
      )
        ? typeof child === "string" && child.length > 0 && child !== "[REDACTED]"
          ? [{ path: childPath, reason: `secret-bearing field ${key}` }]
          : []
        : []
    return [...keyFinding, ...valueFreeFindings(child, childPath)]
  })
}

export function replaySecretFindings(value: unknown) {
  return [...secretFindings(value), ...valueFreeFindings(value)]
}

export function assertReplayValueFree(value: unknown) {
  const findings = replaySecretFindings(value)
  if (findings.length > 0) {
    throw new Error(
      `Replay fixture contains secret-like data: ${findings.map((item) => `${item.path} (${item.reason})`).join(", ")}`,
    )
  }
}

export function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}
