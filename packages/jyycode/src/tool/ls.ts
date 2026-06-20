import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@jyycode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./ls.txt"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"

const DEFAULT_DEPTH = 1
const MAX_DEPTH = 5
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "The absolute path to the directory to list" }),
  depth: Schema.optional(NonNegativeInt).annotate({
    description: "Directory recursion depth. Defaults to 1. Use 1 for a flat listing.",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum number of entries to return. Defaults to 200.",
  }),
  showHidden: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to include hidden dotfiles and dot-directories. Defaults to false.",
  }),
  includeFiles: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to include files. Defaults to true.",
  }),
})

type Entry = {
  text: string
  depth: number
}

const orThrow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        throw error
      }),
    ),
  )

export const LsTool = Tool.define(
  "ls",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const list = (
      dir: string,
      input: { depth: number; limit: number; showHidden: boolean; includeFiles: boolean },
      level = 0,
      output: Entry[] = [],
    ): Effect.Effect<{ entries: Entry[]; truncated: boolean }> =>
      Effect.gen(function* () {
        const entries = yield* orThrow(fs.readDirectoryEntries(dir))
        const sorted = entries
          .filter((entry) => input.showHidden || !entry.name.startsWith("."))
          .filter((entry) => input.includeFiles || entry.type === "directory" || entry.type === "symlink")
          .toSorted((a, b) => {
            const ad = a.type === "directory" ? 0 : 1
            const bd = b.type === "directory" ? 0 : 1
            return ad - bd || a.name.localeCompare(b.name)
          })

        let truncated = false
        for (const entry of sorted) {
          const full = path.join(dir, entry.name)
          let kind = entry.type
          if (entry.type === "symlink") {
            const stat = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (stat?.type === "Directory") kind = "directory"
          }
          const isDir = kind === "directory"
          if (!input.includeFiles && !isDir) continue

          if (output.length >= input.limit) {
            truncated = true
            break
          }

          output.push({ depth: level, text: `${entry.name}${isDir ? "/" : ""}` })
          if (isDir && level + 1 < input.depth) {
            const child = yield* list(full, input, level + 1, output)
            truncated = truncated || child.truncated
            if (output.length >= input.limit && child.truncated) break
          }
        }

        return { entries: output, truncated }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "filesystem",
        mutability: "read",
        risk: "low",
        detail: "core",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          let resolved = params.path
          if (!path.isAbsolute(resolved)) resolved = path.resolve(instance.directory, resolved)
          if (process.platform === "win32") resolved = AppFileSystem.normalizePath(resolved)

          const stat = yield* orThrow(fs.stat(resolved))
          if (stat.type !== "Directory") throw new Error(`Path is a file, not a directory: ${resolved}`)

          yield* assertExternalDirectoryEffect(ctx, resolved, { kind: "directory" })
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, resolved)],
            always: ["*"],
            metadata: {},
          })

          const depth = Math.min(params.depth ?? DEFAULT_DEPTH, MAX_DEPTH)
          const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const { entries, truncated } = yield* list(resolved, {
            depth,
            limit,
            showHidden: params.showHidden ?? false,
            includeFiles: params.includeFiles ?? true,
          })
          const rendered = entries.map((entry) => `${"  ".repeat(entry.depth)}${entry.text}`).join("\n")

          return {
            title: path.relative(instance.worktree, resolved) || ".",
            output: [
              `<path>${resolved}</path>`,
              `<type>directory</type>`,
              `<entries>`,
              rendered,
              truncated
                ? `\n(Showing ${entries.length} of at least ${entries.length + 1} entries. Use a narrower path, lower depth, or higher limit.)`
                : `\n(${entries.length} entries)`,
              `</entries>`,
            ].join("\n"),
            metadata: {
              preview: rendered.split("\n").slice(0, 40).join("\n"),
              truncated,
              count: entries.length,
            },
          }
        }),
    }
  }),
)
