import path from "path"
import { Effect, Layer, Context, Option } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@jyycode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"
import { createHash } from "node:crypto"
import {
  budgetInstructions,
  DEFAULT_INSTRUCTION_FILE_BYTES,
  DEFAULT_INSTRUCTION_TOKENS,
  InstructionBudgetError,
  readFileBounded,
  type BoundedRead,
  type InstructionCandidate,
} from "./instruction-budget"

const files = (disableClaudeCodePrompt: boolean) => ["AGENTS.md", ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"])]

function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = files(flags.disableClaudeCodePrompt)

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          localCache: new Map<string, BoundedRead>(),
          remoteCache: new Map<string, BoundedRead>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.JYYCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string, required = false) {
      const s = yield* InstanceState.get(state)
      const metadata = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const cached = s.localCache.get(filepath)
      const mtimeMs = metadata ? Option.getOrElse(metadata.mtime, () => new Date(0)).getTime() : undefined
      if (cached && metadata && cached.mtimeMs === mtimeMs && cached.size === Number(metadata.size)) {
        return { source: filepath, ...cached, required } satisfies InstructionCandidate
      }
      const result = yield* Effect.tryPromise({
        try: () => readFileBounded(filepath, DEFAULT_INSTRUCTION_FILE_BYTES),
        catch: () => new Error(`failed to read instruction ${filepath}`),
      }).pipe(Effect.catch(() => Effect.succeed<BoundedRead>({ content: "", bytes: 0, digest: "" })))
      s.localCache.set(filepath, result)
      return { source: filepath, ...result, required } satisfies InstructionCandidate
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const s = yield* InstanceState.get(state)
      const cached = s.remoteCache.get(url)
      if (cached) return { source: url, ...cached, required: true } satisfies InstructionCandidate
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(Effect.timeout(5000), Effect.orDie)
      const collected = yield* res.stream
        .pipe(
          Stream.runFold(
            () => ({
              chunks: [] as Uint8Array[],
              bytes: 0,
              retained: 0,
              hash: createHash("sha256"),
            }),
            (acc, chunk) => {
              acc.hash.update(chunk)
              acc.bytes += chunk.byteLength
              const remaining = DEFAULT_INSTRUCTION_FILE_BYTES - acc.retained
              if (remaining > 0) {
                const next = chunk.subarray(0, remaining)
                acc.chunks.push(next)
                acc.retained += next.byteLength
              }
              return acc
            },
          ),
        )
        .pipe(Effect.orDie)
      const bounded: BoundedRead = {
        content: Buffer.concat(collected.chunks.map((item) => Buffer.from(item))).toString("utf8"),
        bytes: collected.bytes,
        digest: collected.hash.digest("hex"),
      }
      s.remoteCache.set(url, bounded)
      return { source: url, ...bounded, required: true } satisfies InstructionCandidate
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.JYYCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const configBudget = config.instruction_budget
      // Preserve the existing source precedence (global before project) while
      // using a stable Set built by systemPaths; precedence is part of the
      // instruction provenance contract.
      const pathsOrdered = Array.from(paths)
      const local = yield* Effect.forEach(
        pathsOrdered,
        (item) => read(item, /(?:^|[\\/])(AGENTS|CLAUDE|CONTEXT)\.md$/i.test(item)),
        { concurrency: 8 },
      )
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
      const candidates = [...local, ...remote]
      const budget = yield* Effect.try({
        try: () =>
          budgetInstructions(candidates, {
            maxFileBytes: configBudget?.max_file_bytes ?? DEFAULT_INSTRUCTION_FILE_BYTES,
            maxTokens: configBudget?.max_total_tokens ?? DEFAULT_INSTRUCTION_TOKENS,
            safetyMargin: configBudget?.safety_margin,
          }),
        catch: (error) => (error instanceof InstructionBudgetError ? error : new Error(String(error))),
      }).pipe(Effect.catch((error) => Effect.die(error)))
      return budget.entries
        .filter((entry) => entry.included)
        .map((entry) => `Instructions from: ${entry.source}\n${entry.content}`)
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: MessageV2.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const candidate = yield* read(found)
        if (candidate.content) {
          const entry = budgetInstructions([candidate], { maxFileBytes: DEFAULT_INSTRUCTION_FILE_BYTES }).entries[0]
          if (entry?.included)
            results.push({ filepath: found, content: `Instructions from: ${found}\n${entry.content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function loaded(messages: MessageV2.WithParts[]) {
  return extract(messages)
}

export * as Instruction from "./instruction"
