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
import PROCESS_START_DESCRIPTION from "./process-start.txt"
import PROCESS_OUTPUT_DESCRIPTION from "./process-output.txt"
import KILL_PROCESS_DESCRIPTION from "./kill-process.txt"

const StartParameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The shell command to start in the background" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "The working directory to run the command in. Defaults to the current workspace directory.",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this process does" }),
})

const OutputParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The process id returned by process_start" }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "Optional 1-based output line offset. Defaults to the tail of the output.",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of output lines to return. Defaults to 200.",
  }),
})

const KillParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The process id returned by process_start" }),
  forceAfterMs: Schema.optional(PositiveInt).annotate({
    description: "Milliseconds to wait before force-killing the process. Defaults to 3000.",
  }),
})

type StartParameters = Schema.Schema.Type<typeof StartParameters>
type OutputParameters = Schema.Schema.Type<typeof OutputParameters>
type KillParameters = Schema.Schema.Type<typeof KillParameters>

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
    info.outputPath ? `<outputPath>${info.outputPath}</outputPath>` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

export const ProcessStartTool = Tool.define(
  "process_start",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const plugin = yield* Plugin.Service
    const processes = yield* BackgroundProcess.Service

    const cygpath = Effect.fn("ProcessStartTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const shellEnv = Effect.fn("ProcessStartTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
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
      description: PROCESS_START_DESCRIPTION,
      parameters: StartParameters,
      catalog: {
        category: "execution",
        mutability: "execute",
        risk: "high",
        detail: "standard",
      },
      execute: (params: StartParameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
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
          })
          const output = [
            "Started background process.",
            "",
            formatInfo(info),
            "",
            "Use process_output with this process id to read output.",
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
        }),
    }
  }),
)

export const ProcessOutputTool = Tool.define(
  "process_output",
  Effect.gen(function* () {
    const processes = yield* BackgroundProcess.Service

    return {
      description: PROCESS_OUTPUT_DESCRIPTION,
      parameters: OutputParameters,
      catalog: {
        category: "execution",
        mutability: "read",
        risk: "medium",
        detail: "standard",
      },
      execute: (params: OutputParameters) =>
        Effect.gen(function* () {
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
        }),
    }
  }),
)

export const KillProcessTool = Tool.define(
  "kill_process",
  Effect.gen(function* () {
    const processes = yield* BackgroundProcess.Service

    return {
      description: KILL_PROCESS_DESCRIPTION,
      parameters: KillParameters,
      catalog: {
        category: "execution",
        mutability: "execute",
        risk: "high",
        detail: "standard",
      },
      execute: (params: KillParameters) =>
        Effect.gen(function* () {
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
            output: ["Stopped background process.", "", formatInfo(info)].join("\n"),
          }
        }),
    }
  }),
)
