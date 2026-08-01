import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import { applyEditOperations, normalizeLineEndings, trimDiff } from "./edit-shared"

export { trimDiff } from "./edit-shared"

const EditItem = Schema.Struct({
  oldString: Schema.String.annotate({ description: "The exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text. Must differ from oldString." }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString for this edit. Defaults to false.",
  }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  edits: Schema.Array(EditItem).check(Schema.isMinLength(1), Schema.isMaxLength(50)).annotate({
    description: "Ordered edits to apply atomically to one file",
  }),
})

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "filesystem",
        mutability: "write",
        risk: "high",
        detail: "core",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""

          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              const next = Bom.split(applyEditOperations(contentOld, params.edits))
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )

              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: { filepath: filePath, diff },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* bus.publish(File.Event.Edited, { file: filePath })
              yield* bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({ metadata: { diff, filediff, diagnostics: {} } })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: { diagnostics, diff, filediff },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)
