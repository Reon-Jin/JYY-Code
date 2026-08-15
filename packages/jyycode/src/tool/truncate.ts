import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import { open, rm } from "node:fs/promises"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Config } from "@/config/config"
import { Identifier } from "../id/id"
import * as Log from "@jyycode-ai/core/util/log"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_PREVIEW_BYTES,
  createOutputRetention,
  type OutputRetentionStrategy,
} from "@jyycode-ai/core/output-retention"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = DEFAULT_OUTPUT_MAX_BYTES
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

export type Result =
  | {
      content: string
      truncated: false
      bytesSeen: number
      bytesRetained: number
      sha256: string
    }
  | {
      content: string
      truncated: true
      outputPath: string
      bytesSeen: number
      bytesRetained: number
      sha256: string
    }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: OutputRetentionStrategy
  toolName?: string
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string, sessionId?: string) => Effect.Effect<string>
  readonly writeStream: (source: AsyncIterable<Uint8Array>, sessionId?: string) => Effect.Effect<string>
  readonly output: (text: string, options?: Options, agent?: Agent.Info, sessionId?: string) => Effect.Effect<Result>
  readonly limits: (toolName?: string) => Effect.Effect<{
    maxLines: number
    maxBytes: number
    previewBytes: number
    provenance: "default" | "config"
  }>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      // A file is stale if its ID timestamp (logical age) or its real mtime
      // is older than the retention window. Checking both keeps the ID-based
      // semantics (and existing tests) while remaining correct after the ID
      // time field would otherwise wrap.
      const isStale = (filePath: string, name: string) =>
        Effect.gen(function* () {
          if (name.startsWith("tool_") && Identifier.timestamp(name) < cutoff) return true
          const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) return false
          return Option.getOrElse(info.mtime, () => new Date(0)).getTime() < cutoff
        })
      const rootEntries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of rootEntries) {
        const fullPath = path.join(TRUNCATION_DIR, entry)
        if (yield* fs.isDir(fullPath).pipe(Effect.catch(() => Effect.succeed(false)))) {
          const subEntries = yield* fs.readDirectory(fullPath).pipe(Effect.catch(() => Effect.succeed([])))
          for (const sub of subEntries) {
            const subPath = path.join(fullPath, sub)
            if (yield* isStale(subPath, sub)) {
              yield* fs.remove(subPath).pipe(Effect.catch(() => Effect.void))
            }
          }
          const remaining = yield* fs.readDirectory(fullPath).pipe(Effect.catch(() => Effect.succeed([])))
          if (remaining.length === 0) {
            yield* fs.remove(fullPath).pipe(Effect.catch(() => Effect.void))
          }
        } else if (yield* isStale(fullPath, entry)) {
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

    const writeStream = Effect.fn("Truncate.writeStream")(function* (
      source: AsyncIterable<Uint8Array>,
      sessionId?: string,
    ) {
      const dir = sessionDir(sessionId)
      const file = path.join(dir, ToolID.ascending())
      yield* fs.ensureDir(dir).pipe(Effect.orDie)
      yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(file, "wx")
          try {
            for await (const chunk of source) await handle.write(chunk)
          } catch (error) {
            await rm(file, { force: true }).catch(() => undefined)
            throw error
          } finally {
            await handle.close()
          }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* (toolName?: string) {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) {
        return {
          maxLines: MAX_LINES,
          maxBytes: MAX_BYTES,
          previewBytes: DEFAULT_OUTPUT_PREVIEW_BYTES,
          provenance: "default" as const,
        }
      }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!cfg) {
        return {
          maxLines: MAX_LINES,
          maxBytes: MAX_BYTES,
          previewBytes: DEFAULT_OUTPUT_PREVIEW_BYTES,
          provenance: "default" as const,
        }
      }
      const defaultMaxBytes = cfg?.tool_output?.max_bytes ?? MAX_BYTES
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: toolName ? maxBytesForTool(toolName, defaultMaxBytes) : defaultMaxBytes,
        previewBytes: cfg?.tool_output?.preview_bytes ?? DEFAULT_OUTPUT_PREVIEW_BYTES,
        provenance: "config" as const,
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
      const strategy = direction
      const retention = createOutputRetention({ maxBytes, strategy })
      yield* Effect.promise(() => retention.append(text))
      const retained = yield* Effect.promise(() => retention.flush())
      const lines = retained.preview.split("\n")
      const lineTruncated = lines.length > maxLines
      const preview = lineTruncated
        ? strategy === "tail"
          ? lines.slice(-maxLines).join("\n")
          : strategy === "head_tail"
            ? (() => {
                const headCount = Math.ceil(maxLines / 2)
                const tailCount = Math.floor(maxLines / 2)
                return (
                  tailCount > 0 ? [...lines.slice(0, headCount), ...lines.slice(-tailCount)] : lines.slice(0, headCount)
                ).join("\n")
              })()
            : lines.slice(0, maxLines).join("\n")
        : retained.preview
      const bytesTruncated = retained.truncated
      const truncated = bytesTruncated || lineTruncated
      if (!truncated) {
        return {
          content: text,
          truncated: false,
          bytesSeen: retained.bytesSeen,
          bytesRetained: retained.bytesRetained,
          sha256: retained.sha256,
        } as const
      }
      const file = yield* write(text, sessionId)
      const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
      const lineRemoved = Math.max(0, lines.length - maxLines)
      const byteRemoved = Math.max(0, retained.bytesSeen - retained.bytesRetained)
      const detail =
        bytesTruncated && lineTruncated
          ? `...${byteRemoved} bytes and ${lineRemoved} lines truncated...`
          : bytesTruncated
            ? `...${byteRemoved} bytes truncated...`
            : `...${lineRemoved} lines truncated...`

      return {
        content: strategy === "tail" ? `${detail}\n\n${hint}\n\n${preview}` : `${preview}\n\n${detail}\n\n${hint}`,
        truncated: true,
        outputPath: file,
        bytesSeen: retained.bytesSeen,
        bytesRetained: retained.bytesRetained,
        sha256: retained.sha256,
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

    return Service.of({ cleanup, write, writeStream, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

export * as Truncate from "./truncate"
