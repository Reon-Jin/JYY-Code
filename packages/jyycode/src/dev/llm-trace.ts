import fs from "fs"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Stream } from "effect"
import type { LLMEvent } from "@jyycode-ai/llm"
import type { ModelMessage } from "ai"
import { InstallationLocal } from "@jyycode-ai/core/installation/version"
import type { LLMRequestPrep } from "@/session/llm/request"

const LINE = "=".repeat(80)
const SEP = "-".repeat(80)

const devBuild = typeof JYYCODE_DEV_TRACE === "string" ? JYYCODE_DEV_TRACE === "true" : false

let enabled = false
let logDir = ""
let logFile = ""
let nextID = 1

export interface TraceStartInput {
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: {
    readonly providerID: string
    readonly id: string
  }
  readonly agent: {
    readonly name: string
    readonly mode?: string
  }
  readonly user: {
    readonly id?: string
  }
  readonly messages?: readonly ModelMessage[]
  readonly prepared: LLMRequestPrep.Prepared
}

export interface Trace {
  readonly id: number
  readonly pid: number
  readonly startedAt: number
  active: boolean
  text: string
  reasoning: string
  calls: Array<{ readonly name: string; readonly input: unknown }>
  results: Array<{ readonly name: string; readonly result: unknown }>
  errors: string[]
  usage?: unknown
  finishReason?: string
}

const pad = (value: number) => String(value).padStart(2, "0")

function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`
}

function fileDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function pretty(value: unknown): string {
  if (value === undefined) return "(undefined)"
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value, null, 2) ?? "(unserializable)"
  } catch {
    return "(unserializable)"
  }
}

function enqueue(text: string) {
  if (!enabled || !logFile) return
  try {
    fs.appendFileSync(logFile, text.endsWith("\n") ? text : `${text}\n`)
  } catch {
    // Logging must never break the application. A failed trace write is ignored.
  }
}

/**
 * Start dev-mode LLM tracing. This is a no-op in official installs because
 * `InstallationLocal` is only true when running from the local source tree,
 * and the desktop dev sidecar is the only compiled build that sets
 * `JYYCODE_DEV_TRACE` to "true".
 */
export function init(): void {
  if (enabled || !(InstallationLocal || devBuild) || process.env.JYYCODE_LLM_TRACE === "0") return
  logDir = process.env.JYYCODE_LLM_TRACE_DIR ?? path.join(os.homedir(), "Desktop", "log")
  logFile = path.join(logDir, `llm-trace-${fileDate()}.log`)
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(
      logFile,
      `${LINE}
[${timestamp()}] JYYCode LLM trace started (dev only)
log directory: ${logDir}
${SEP}

`,
    )
    enabled = true
  } catch {
    enabled = false
  }
}

export function start(input: TraceStartInput): Trace {
  const trace: Trace = {
    id: nextID++,
    pid: process.pid,
    startedAt: Date.now(),
    active: enabled,
    text: "",
    reasoning: "",
    calls: [],
    results: [],
    errors: [],
  }
  if (!enabled) return trace
  enqueue(formatRequest(trace, input))
  return trace
}

function formatRequest(trace: Trace, input: TraceStartInput): string {
  const prepared = input.prepared
  const messages = input.messages ?? prepared.messages
  const lines = [
    LINE,
    `[${timestamp()}] REQUEST #${trace.id}`,
    `processID: ${trace.pid}`,
    `sessionID: ${input.sessionID}`,
    input.parentSessionID ? `parentSessionID: ${input.parentSessionID}` : "",
    `agent: ${input.agent.name}`,
    input.agent.mode ? `agent mode: ${input.agent.mode}` : "",
    `model: ${input.model.providerID}/${input.model.id}`,
    input.user.id ? `userMessageID: ${input.user.id}` : "",
    "",
    "## System prompt",
    "",
    prepared.system.join("\n\n---\n\n"),
    "",
    "## Messages",
    "",
    ...messages.filter((message) => message.role !== "system").map(formatMessage),
    "## Tools",
    "",
    ...Object.entries(prepared.tools).map(([name, tool]) => formatTool(name, tool)),
    "## Generation params",
    "",
    pretty({
      temperature: prepared.params.temperature,
      topP: prepared.params.topP,
      topK: prepared.params.topK,
      maxOutputTokens: prepared.params.maxOutputTokens,
    }),
    "",
  ].filter((line) => line !== "")
  return `${lines.join("\n")}\n`
}

function formatMessage(message: ModelMessage): string {
  const content = typeof message.content === "string" ? message.content : message.content.map(formatPart).join("\n")
  return `### ${message.role}\n\n${content || "(empty)"}`
}

function formatPart(part: unknown): string {
  if (!isRecord(part)) return pretty(part)
  const type = typeof part.type === "string" ? part.type : ""
  const text = typeof part.text === "string" ? part.text : ""
  switch (type) {
    case "text":
      return text || pretty(part)
    case "file":
    case "image": {
      const label =
        typeof part.filename === "string"
          ? part.filename
          : typeof part.mediaType === "string"
            ? part.mediaType
            : "unknown"
      return `[${type}: ${label}]`
    }
    case "reasoning":
      return `[reasoning]\n${text || pretty(part)}`
    case "tool-call": {
      const name = typeof part.toolName === "string" ? part.toolName : "unknown"
      return `[tool-call: ${name}]\n${pretty(part.input ?? part.args ?? "")}`
    }
    case "tool-result": {
      const name = typeof part.toolName === "string" ? part.toolName : "unknown"
      return `[tool-result: ${name}]\n${formatToolOutput(part.output)}`
    }
    case "tool-approval-request":
    case "tool-approval-response":
    case "custom":
      return `[${type}]\n${pretty(part)}`
    default:
      return pretty(part)
  }
}

function formatToolOutput(output: unknown): string {
  if (!isRecord(output)) return pretty(output)
  const type = typeof output.type === "string" ? output.type : ""
  const value = output.value
  switch (type) {
    case "text":
    case "error-text":
      return typeof value === "string" ? value : pretty(value)
    case "json":
    case "error-json":
      return pretty(value)
    case "execution-denied":
      return `Execution denied${typeof output.reason === "string" ? `: ${output.reason}` : ""}`
    case "content":
      return Array.isArray(value) ? value.map(formatPart).join("\n") : pretty(value)
    default:
      return pretty(output)
  }
}

function formatTool(name: string, tool: unknown): string {
  if (!isRecord(tool)) return `### ${name}\n\n(no description)\n\nInput schema:\n(none)`
  const description =
    typeof tool.description === "string"
      ? tool.description
      : typeof tool.title === "string"
        ? tool.title
        : "(no description)"
  return `### ${name}\n\n${description}\n\nInput schema:\n${pretty(tool.inputSchema)}`
}

export function observe(trace: Trace, event: LLMEvent): void {
  if (!trace.active) return
  if (event.type === "text-delta") {
    trace.text += event.text
    return
  }
  if (event.type === "reasoning-delta") {
    trace.reasoning += event.text
    return
  }
  if (event.type === "tool-call") {
    trace.calls.push({ name: event.name, input: event.input })
    return
  }
  if (event.type === "tool-result") {
    trace.results.push({ name: event.name, result: event.result })
    return
  }
  if (event.type === "tool-error") {
    trace.errors.push(`${event.name}: ${event.message}`)
    return
  }
  if (event.type === "step-finish" || event.type === "finish") {
    if (event.usage !== undefined) trace.usage = event.usage
    if (event.type === "finish") trace.finishReason = event.reason
  }
}

export function finish(trace: Trace): void {
  if (!trace.active) return
  trace.active = false

  const status = trace.errors.length > 0 ? "error" : trace.finishReason ? "finished" : "ended"
  const lines = [
    SEP,
    `[${timestamp()}] RESPONSE #${trace.id}`,
    `processID: ${trace.pid}`,
    `status: ${status}`,
    `duration: ${Date.now() - trace.startedAt}ms`,
    trace.finishReason ? `finishReason: ${trace.finishReason}` : "",
    trace.usage ? `usage: ${pretty(trace.usage)}` : "",
    "",
  ].filter((line) => line !== "")

  if (trace.reasoning) {
    lines.push("## Reasoning", "", trace.reasoning, "")
  }
  if (trace.text) {
    lines.push("## Assistant text", "", trace.text, "")
  }
  if (trace.calls.length > 0) {
    lines.push("## Tool calls", "")
    for (const call of trace.calls) {
      lines.push(`### ${call.name}`, "", pretty(call.input), "")
    }
  }
  if (trace.results.length > 0) {
    lines.push("## Tool results", "")
    for (const result of trace.results) {
      lines.push(`### ${result.name}`, "", formatToolOutput(result.result), "")
    }
  }
  if (trace.errors.length > 0) {
    lines.push("## Errors", "")
    for (const error of trace.errors) {
      lines.push(`- ${error}`)
    }
    lines.push("")
  }
  if (!trace.text && !trace.reasoning && trace.calls.length === 0) {
    lines.push("(no text output)")
    lines.push("")
  }
  lines.push(LINE, "")
  enqueue(lines.join("\n"))
}

export function wrap<E, R>(stream: Stream.Stream<LLMEvent, E, R>, trace: Trace): Stream.Stream<LLMEvent, E, R> {
  if (!trace.active) return stream
  return stream.pipe(
    Stream.tap((event) => Effect.sync(() => observe(trace, event))),
    Stream.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) trace.errors.push(Cause.pretty(exit.cause))
        finish(trace)
      }),
    ),
  )
}

export function isEnabled(): boolean {
  return enabled
}

export const LLMTrace = {
  init,
  isEnabled,
  start,
  wrap,
} as const
