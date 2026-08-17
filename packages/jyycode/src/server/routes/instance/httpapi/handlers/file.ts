import * as InstanceState from "@/effect/instance-state"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { FileConflictError, FileTooLargeError, FileUnsupportedWriteError, FileUnsafePathError } from "../groups/file"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      return yield* svc.search({
        query: ctx.query.query,
        limit: ctx.query.limit ?? 10,
        dirs: ctx.query.dirs !== "false",
        type: ctx.query.type,
      })
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      return yield* svc.list(ctx.query.path)
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      return yield* svc.read(ctx.query.path)
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: { payload: File.WriteInput }) {
      return yield* svc.write(ctx.payload).pipe(
        Effect.catchTag("FileUnsafePathError", (error) =>
          Effect.fail(new FileUnsafePathError({ name: "FileUnsafePathError", data: { message: error.message } })),
        ),
        Effect.catchTag("FileUnsupportedWriteError", (error) =>
          Effect.fail(
            new FileUnsupportedWriteError({
              name: "FileUnsupportedWriteError",
              data: { message: error.message },
            }),
          ),
        ),
        Effect.catchTag("FileTooLargeError", (error) =>
          Effect.fail(new FileTooLargeError({ name: "FileTooLargeError", data: { message: error.message } })),
        ),
        Effect.catchTag("FileRevisionConflictError", (error) =>
          Effect.fail(
            new FileConflictError({
              name: "FileConflictError",
              data: {
                message: error.message,
                currentRevision: error.currentRevision,
                expectedRevision: error.expectedRevision,
              },
            }),
          ),
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return yield* svc.status()
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("write", write)
      .handle("status", status)
  }),
)
