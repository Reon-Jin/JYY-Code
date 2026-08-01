import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Config } from "@/config/config"
import { Identifier } from "../id/id"
import * as Log from "@jyycode-ai/core/util/log"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

/** Per-tool-type truncation strategies. */
export type TruncationStrategy = "head" | "tail" | "head_tail"

export const TOOL_STRATEGY: Record<string, TruncationStrategy> = {
  read: "head",
  grep: "head",
  glob: "head",
  shell: "tail",
  webfetch: "head",
  websearch: "head",
}

export function strategyForTool(toolName: string): TruncationStrategy {
  return TOOL_STRATEGY[toolName] ?? "head"
}

export const TOOL_MAX_BYTES: Record<string, number> = {
  grep: 30 * 1024,
  glob: 10 * 1024,
  websearch: 20 * 1024,
}

export function maxBytesForTool(toolName: string, defaultMax: number): number {
  return TOOL_MAX_BYTES[toolName] ?? defaultMax
}

export function sessionDir(sessionId?: string): string {
  return sessionId ? path.join(TRUNCATION_DIR, sessionId) : TRUNCATION_DIR
}

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  toolName?: string
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string, sessionId?: string) => Effect.Effect<string>
  readonly output: (text: string, options?: Options, agent?: Agent.Info, sessionId?: string) => Effect.Effect<Result>
  readonly limits: (toolName?: string) => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const rootEntries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of rootEntries) {
        const fullPath = path.join(TRUNCATION_DIR, entry)
        if (yield* fs.isDir(fullPath).pipe(Effect.catch(() => Effect.succeed(false)))) {
          const subEntries = yield* fs.readDirectory(fullPath).pipe(Effect.catch(() => Effect.succeed([])))
          for (const sub of subEntries) {
            if (Identifier.timestamp(sub) < cutoff) {
              yield* fs.remove(path.join(fullPath, sub)).pipe(Effect.catch(() => Effect.void))
            }
          }
          const remaining = yield* fs.readDirectory(fullPath).pipe(Effect.catch(() => Effect.succeed([])))
          if (remaining.length === 0) {
            yield* fs.remove(fullPath).pipe(Effect.catch(() => Effect.void))
          }
        } else if (entry.startsWith("tool_") && Identifier.timestamp(entry) < cutoff) {
          yield* fs.remove(fullPath).pipe(Effect.catch(() => Effect.void))
        }
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string, sessionId?: string) {
      const dir = sessionDir(sessionId)
      const file = path.join(dir, ToolID.ascending())
      yield* fs.ensureDir(dir).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* (toolName?: string) {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const defaultMaxBytes = cfg?.tool_output?.max_bytes ?? MAX_BYTES
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: toolName ? maxBytesForTool(toolName, defaultMaxBytes) : defaultMaxBytes,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (
      text: string,
      options: Options = {},
      _agent?: Agent.Info,
      sessionId?: string,
    ) {
      const resolved = yield* limits(options.toolName)
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? (options.toolName ? strategyForTool(options.toolName) : "head")
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(text, sessionId)

      const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

export * as Truncate from "./truncate"
