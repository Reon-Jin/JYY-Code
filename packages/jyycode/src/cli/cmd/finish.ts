import { Effect } from "effect"
import path from "path"
import { EOL } from "os"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { sendMessage } from "@/communication"
import { defaultEmailRecipient } from "@/communication/defaults"

export const FinishCommand = effectCmd({
  command: "finish [notes..]",
  describe: "send a work summary email",
  builder: (yargs) =>
    yargs
      .positional("notes", {
        describe: "optional notes to include in the summary",
        type: "string",
        array: true,
        default: [],
      })
      .option("to", {
        describe: "recipient email address",
        type: "string",
      })
      .option("subject", {
        describe: "email subject override",
        type: "string",
      })
      .option("dry-run", {
        describe: "print the summary without sending email",
        type: "boolean",
        default: false,
  }),
  handler: Effect.fn("Cli.finish")(function* (args) {
    const cfg = yield* Config.Service
    const git = yield* Git.Service
    const info = yield* cfg.get()
    const email = info.communication?.email
    if (!email) return yield* fail("Email is not configured. Add communication.email to jyycode.jsonc.")

    const cwd = process.cwd()
    const notes = [...(args.notes ?? []), ...(args["--"] ?? [])].join(" ").trim()
    const summary = yield* buildSummary(git, cwd, notes)
    const subject = args.subject ?? `JYYCode finish: ${path.basename(cwd)}${summary.branch ? ` (${summary.branch})` : ""}`
    const to = args.to ?? defaultEmailRecipient(info)

    if (args["dry-run"]) {
      UI.println(summary.body)
      return
    }

    const result = yield* Effect.promise(() =>
      sendMessage(
        { email },
        {
          channel: "email",
          to,
          subject,
          body: summary.body,
        },
      ),
    )
    if (!result.success) return yield* fail(result.message)
    UI.println(`Finish report sent to ${to}`)
  }),
})

const buildSummary = Effect.fn("Cli.finish.summary")(function* (git: Git.Interface, cwd: string, notes: string) {
  const inside = yield* git.run(["rev-parse", "--is-inside-work-tree"], { cwd })
  const now = new Date().toLocaleString()
  if (inside.exitCode !== 0) {
    return {
      branch: undefined,
      body: [
        "JYYCode 工作收尾报告",
        "",
        `时间: ${now}`,
        `目录: ${cwd}`,
        "Git: 当前目录不是 git 仓库，无法生成 diff/status 摘要。",
        "",
        "备注:",
        notes || "未填写",
      ].join(EOL),
    }
  }

  const branch = yield* git.branch(cwd)
  const head = yield* git.run(["rev-parse", "--short", "HEAD"], { cwd })
  const status = yield* git.status(cwd)
  const stat = yield* git.run(["diff", "--stat", "HEAD", "--", "."], { cwd, maxOutputBytes: 12000 })
  const counts = status.reduce(
    (acc, item) => ({
      added: acc.added + (item.status === "added" ? 1 : 0),
      modified: acc.modified + (item.status === "modified" ? 1 : 0),
      deleted: acc.deleted + (item.status === "deleted" ? 1 : 0),
    }),
    { added: 0, modified: 0, deleted: 0 },
  )
  const changed = status
    .slice(0, 80)
    .map((item) => `${item.code} ${item.file}`)
    .join(EOL)

  return {
    branch,
    body: [
      "JYYCode 工作收尾报告",
      "",
      `时间: ${now}`,
      `目录: ${cwd}`,
      `分支: ${branch ?? "未知"}`,
      `HEAD: ${head.exitCode === 0 ? head.text().trim() : "未知"}`,
      "",
      "工作状态:",
      status.length === 0
        ? "工作区干净，没有未提交改动。"
        : `共有 ${status.length} 个变更文件：新增 ${counts.added}，修改 ${counts.modified}，删除 ${counts.deleted}。`,
      "",
      "备注:",
      notes || "未填写",
      "",
      "Diff 统计:",
      stat.exitCode === 0 && stat.text().trim() ? stat.text().trim() : "无 tracked diff 统计。",
      "",
      "变更文件:",
      changed || "无",
      ...(status.length > 80 ? [`还有 ${status.length - 80} 个文件未列出。`] : []),
    ].join(EOL),
  }
})
