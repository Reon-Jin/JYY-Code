import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { PositiveInt } from "@jyycode-ai/core/schema"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { BackgroundProcess } from "@/process/job"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import * as Tool from "./tool"
import { commandProcess } from "./shell/command"
import { askShellPermissions, collectShellPermissions, parseShellCommand, resolveShellPath } from "./shell/scan"
import DESCRIPTION from "./process.txt"

const StartParameters = Schema.Struct({
  action: Schema.Literal("start"),
  command: Schema.String.annotate({ description: "The shell command to start in the background" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "The working directory to run the command in. Defaults to the current workspace directory.",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this process does" }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Maximum lifetime in milliseconds. Defaults to 10 minutes and is capped at 60 minutes.",
  }),
})

const OutputParameters = Schema.Struct({
  action: Schema.Literal("output"),
  id: Schema.String.annotate({ description: "The process id returned by the start action" }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "Optional 1-based output line offset. Defaults to the tail of the output.",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of output lines to return. Defaults to 200.",
  }),
})

const KillParameters = Schema.Struct({
  action: Schema.Literal("kill"),
  id: Schema.String.annotate({ description: "The process id returned by the start action" }),
  forceAfterMs: Schema.optional(PositiveInt).annotate({
    description: "Milliseconds to wait before force-killing the process. Defaults to 3000.",
  }),
})

export const Parameters = Schema.Union([StartParameters, OutputParameters, KillParameters]).annotate({
  discriminator: "action",
  identifier: "ProcessParameters",
})
export type ProcessParameters = Schema.Schema.Type<typeof Parameters>

type ProcessMetadata = {
  process_id: string
  status: string
  description?: string
  exit?: number | null
  outputPath?: string
  truncated: boolean
}

function formatInfo(info: BackgroundProcess.Info) {
  return [
    `<process_id>${info.id}</process_id>`,
    `<status>${info.status}</status>`,
    `<command>${info.command}</command>`,
    `<cwd>${info.cwd}</cwd>`,
    info.exit !== undefined ? `<exit>${info.exit ?? "null"}</exit>` : undefined,
    info.owner_session_id ? `<owner_session_id>${info.owner_session_id}</owner_session_id>` : undefined,
    info.deadline_at !== undefined ? `<deadline_at>${info.deadline_at}</deadline_at>` : undefined,
    info.termination_reason ? `<termination_reason>${info.termination_reason}</termination_reason>` : undefined,
    info.outputPath ? `<outputPath>${info.outputPath}</outputPath>` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ProcessTool = Tool.define(
  "process",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const plugin = yield* Plugin.Service
    const processes = yield* BackgroundProcess.Service

    const cygpath = Effect.fn("ProcessTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const shellEnv = Effect.fn("ProcessTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "execution",
        mutability: "execute",
        risk: "high",
        detail: "standard",
      },
      execute: (params: ProcessParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "start") {
            const instanceCtx = yield* InstanceState.context
            const cfg = yield* config.get()
            const shell = Shell.acceptable(cfg.shell)
            const cwd = params.workdir
              ? yield* resolveShellPath(params.workdir, instanceCtx.directory, shell, cygpath)
              : instanceCtx.directory
            const ps = Shell.ps(shell)

            yield* Effect.scoped(
              Effect.gen(function* () {
                const tree = yield* Effect.acquireRelease(parseShellCommand(params.command, ps), (tree) =>
                  Effect.sync(() => tree.delete()),
                )
                const scan = yield* collectShellPermissions(tree.rootNode, cwd, ps, shell, instanceCtx, cygpath).pipe(
                  Effect.provideService(AppFileSystem.Service, fs),
                )
                if (!path.isAbsolute(cwd)) {
                  scan.dirs.add(path.resolve(instanceCtx.directory, cwd))
                } else if (!containsPath(cwd, instanceCtx)) {
                  scan.dirs.add(cwd)
                }
                yield* askShellPermissions(ctx, scan)
              }),
            )

            const env = yield* shellEnv(ctx, cwd)
            const info = yield* processes.start({
              command: commandProcess(shell, params.command, cwd, env),
              rawCommand: params.command,
              cwd,
              env,
              title: params.description,
              owner_session_id: ctx.sessionID,
              timeout: params.timeout,
            })
            const output = [
              "Started background process.",
              "",
              formatInfo(info),
              "",
              "Use the process output action with this process id to read output.",
            ].join("\n")
            yield* ctx.metadata({
              title: params.description,
              metadata: { process_id: info.id, status: info.status, description: params.description },
            })
            const metadata: ProcessMetadata = {
              process_id: info.id,
              status: info.status,
              description: params.description,
              truncated: false,
            }
            return {
              title: params.description,
              metadata,
              output,
            }
          }

          if (params.action === "output") {
            const result = yield* processes.output(params)
            if (!result.info) {
              const metadata: ProcessMetadata = { process_id: params.id, status: "missing", truncated: false }
              return {
                title: `Process ${params.id}`,
                metadata,
                output: `No background process found for id ${params.id}.`,
              }
            }
            const metadata: ProcessMetadata = {
              process_id: result.info.id,
              status: result.info.status,
              exit: result.info.exit,
              outputPath: result.info.outputPath,
              truncated: result.info.truncated ?? false,
            }
            return {
              title: result.info.title ?? `Process ${params.id}`,
              metadata,
              output: [formatInfo(result.info), "", result.output || "(no output)"].join("\n"),
            }
          }

          const info = yield* processes.kill(params)
          if (!info) {
            const metadata: ProcessMetadata = { process_id: params.id, status: "missing", truncated: false }
            return {
              title: `Process ${params.id}`,
              metadata,
              output: `No background process found for id ${params.id}.`,
            }
          }
          const metadata: ProcessMetadata = {
            process_id: info.id,
            status: info.status,
            exit: info.exit,
            truncated: false,
          }
          return {
            title: info.title ?? `Process ${params.id}`,
            metadata,
            output:
              info.status === "kill_failed"
                ? ["Failed to verify background process termination.", "", formatInfo(info)].join("\n")
                : ["Stopped background process.", "", formatInfo(info)].join("\n"),
          }
        }),
    }
  }),
)
