import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { AppProcess } from "@jyycode-ai/core/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"
import { MessageV2 } from "../../session/message-v2"
import { MessageID, PartID } from "../../session/schema"
import { planRecovery } from "../../session/compaction-recovery"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.JYYCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.JYYCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionDeleteCommand).command(SessionRecoverCommand).demandCommand(),
  async handler() {},
})

export const SessionRecoverCommand = effectCmd({
  command: "recover <sessionID>",
  describe: "inspect or copy a session through bounded compaction recovery",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to recover",
        type: "string",
        demandOption: true,
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        description: "inspect recovery chunks without creating a session",
      })
      .option("chunked", {
        type: "boolean",
        default: false,
        description: "recover through bounded 50-message chunks",
      })
      .option("create-copy", {
        type: "boolean",
        default: false,
        description: "create a new session and copy recovered messages",
      }),
  handler: Effect.fn("Cli.session.recover")(function* (args) {
    if (!args.dryRun && !args.createCopy) return yield* fail("choose --dry-run or --create-copy")
    const sessions = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    const original = yield* sessions
      .get(sessionID)
      .pipe(
        Effect.mapError(
          (error) => new CliError({ message: error instanceof Error ? error.message : `Session not found: ${args.sessionID}` }),
        ),
      )
    const messages = yield* sessions
      .messages({ sessionID })
      .pipe(Effect.mapError((error) => new CliError({ message: error instanceof Error ? error.message : String(error) })))
    const plan = planRecovery(messages, {
      pageSize: args.chunked ? 50 : Math.max(1, messages.length),
    })
    const report: Record<string, unknown> = {
      sourceSessionID: args.sessionID,
      sourceHighWatermark: plan.sourceHighWatermark,
      pages: plan.pages,
      chunks: plan.chunks.map((chunk) => ({
        index: chunk.index,
        itemCount: chunk.items.length,
        tokens: chunk.measure.tokens,
        bytes: chunk.measure.bytes,
      })),
      measure: plan.measure,
      truncated: plan.truncated,
      dryRun: !args.createCopy,
    }

    if (args.createCopy) {
      const copy = yield* sessions.create({
        title: `${original.title} (recovered copy)`,
        agent: original.agent,
        model: original.model,
        goal: original.goal,
        permission: original.permission,
        directory: original.directory,
      })
      const messageIDs = new Map<string, MessageID>()
      for (const chunk of plan.chunks) {
        for (const message of chunk.items) {
          const info = structuredClone(message.info) as MessageV2.Info
          const newMessageID = MessageID.ascending()
          messageIDs.set(message.info.id, newMessageID)
          info.id = newMessageID
          info.sessionID = copy.id
          if (info.role === "assistant") info.parentID = messageIDs.get(info.parentID) ?? info.parentID
          yield* sessions.updateMessage(info)
          for (const part of message.parts) {
            const cloned = structuredClone(part)
            cloned.id = PartID.ascending()
            cloned.sessionID = copy.id
            cloned.messageID = newMessageID
            yield* sessions.updatePart(cloned)
          }
        }
      }
      report.copySessionID = copy.id
      report.dryRun = false
    }

    process.stdout.write(`${JSON.stringify(report)}\n`)
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      const pager = pagerCmd()
      const appProcess = yield* AppProcess.Service
      yield* appProcess
        .run({
          command: pager[0]!,
          args: pager.slice(1),
          env: { mode: "inherit-allowlist" },
          stdin: output,
          output: "inherit",
        })
        .pipe(Effect.orDie)
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
