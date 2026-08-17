import type { Argv } from "yargs"
import { Effect } from "effect"
import path from "node:path"
import os from "node:os"
import { Global } from "@jyycode-ai/core/global"
import { Config } from "@/config/config"
import { Database } from "@/storage/db"
import { eq } from "@/storage/db"
import { ProjectID } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import {
  applyWorkspaceMigration,
  inspectWorkspaceStorage,
  type WorkspaceInventoryResult,
} from "@/plan/workspace-sweeper"
import { CliError, effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

function print(value: unknown, json: boolean) {
  process.stdout.write(`${json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`)
}

function safeProject(project: string) {
  if (!project || path.basename(project) !== project || project === "." || project === "..")
    throw new CliError({ message: "project must be a single safe directory name" })
  return project
}

function displayPath(value: string, showPaths: boolean) {
  if (showPaths) return value
  const home = os.homedir()
  if (value === Global.Path.data || value.startsWith(`${Global.Path.data}${path.sep}`)) {
    return `<jyycode-data>${value.slice(Global.Path.data.length)}`
  }
  if (value === home || value.startsWith(`${home}${path.sep}`)) return `~${value.slice(home.length)}`
  return `<path>${path.basename(value)}`
}

export function formatPlanWorkspaceReport(report: WorkspaceInventoryResult, showPaths: boolean) {
  const mapItem = (item: WorkspaceInventoryResult["items"][number]) => ({
    ...item,
    ...(showPaths
      ? {}
      : {
          source_root: displayPath(item.source_root, false),
          directory: undefined,
          identity: { ...item.identity, realpath: undefined },
        }),
    ...(showPaths ? {} : { identity: { ...item.identity, realpath: undefined } }),
  })
  const items = report.items.map(mapItem)
  return {
    ...report,
    runtime_root: displayPath(report.runtime_root, showPaths),
    legacy_roots: report.legacy_roots.map((root) => displayPath(root, showPaths)),
    index_path: displayPath(report.index_path, showPaths),
    items,
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([category, values]) => [category, values.map(mapItem)]),
    ),
  }
}

function sessionContext() {
  try {
    const rows = Database.legacyClient()
      .select({ id: SessionTable.id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.project_id, ProjectID.global))
      .all()
    return {
      sessionIds: rows.map((row) => String(row.id)),
      planRoots: rows.map((row) => String(row.directory)),
    }
  } catch {
    return { sessionIds: [], planRoots: [] }
  }
}

function roots(project: string, legacyRoot: string | undefined, runtimeOverride?: string) {
  const runtimeRoot = runtimeOverride
    ? path.resolve(runtimeOverride)
    : path.join(Global.Path.data, "plan-workspaces", project)
  const legacyRoots = new Set<string>()
  if (project === "global") legacyRoots.add(path.join(Global.Path.data, "global"))
  if (legacyRoot) legacyRoots.add(path.resolve(legacyRoot))
  legacyRoots.delete(path.resolve(runtimeRoot))
  return { runtimeRoot, legacyRoots: [...legacyRoots] }
}

const InspectCommand = effectCmd({
  command: "inspect",
  describe: "inventory plan workspaces without modifying them",
  builder: (yargs: Argv) =>
    yargs
      .option("project", { type: "string", default: "global", description: "project storage namespace" })
      .option("root", { type: "string", description: "runtime root override for diagnostics/tests" })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" })
      .option("show-paths", { type: "boolean", default: false, description: "include absolute filesystem paths" }),
  handler: Effect.fn("Cli.debug.planWorkspaces.inspect")(function* (args) {
    const project = safeProject(args.project)
    const config = yield* Config.Service.use((service) => service.get())
    const pathConfig = roots(project, config.workspace_cleanup?.legacy_root, args.root)
    const context = sessionContext()
    const report = yield* Effect.tryPromise({
      try: () =>
        inspectWorkspaceStorage({
          project,
          runtimeRoot: pathConfig.runtimeRoot,
          legacyRoots: pathConfig.legacyRoots,
          planRoots: context.planRoots,
          sessionIds: context.sessionIds,
          maxEntries: config.workspace_cleanup?.inventory_max_entries,
        }),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    print(formatPlanWorkspaceReport(report, args["show-paths"] === true), args.json === true)
  }),
})

const CleanupCommand = effectCmd({
  command: "cleanup",
  describe: "show or apply conservative workspace quarantine recommendations",
  builder: (yargs: Argv) =>
    yargs
      .option("project", { type: "string", default: "global", description: "project storage namespace" })
      .option("root", { type: "string", description: "runtime root override for diagnostics/tests" })
      .option("dry-run", {
        type: "boolean",
        default: true,
        description: "report recommendations without changing storage",
      })
      .option("apply", {
        type: "string",
        description: "one or more cleanup IDs from a previous dry-run, comma-separated",
      })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" })
      .option("show-paths", { type: "boolean", default: false, description: "include absolute filesystem paths" }),
  handler: Effect.fn("Cli.debug.planWorkspaces.cleanup")(function* (args) {
    const project = safeProject(args.project)
    const config = yield* Config.Service.use((service) => service.get())
    const pathConfig = roots(project, config.workspace_cleanup?.legacy_root, args.root)
    const context = sessionContext()
    const base = {
      project,
      runtimeRoot: pathConfig.runtimeRoot,
      legacyRoots: pathConfig.legacyRoots,
      planRoots: context.planRoots,
      sessionIds: context.sessionIds,
      maxEntries: config.workspace_cleanup?.inventory_max_entries,
    }
    const report = yield* Effect.tryPromise({
      try: () => inspectWorkspaceStorage(base),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    const ids =
      args.apply
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? []
    if (ids.length === 0) {
      print(
        {
          mode: "dry-run",
          recommendations: report.items.filter((item) => item.eligible),
          inventory: formatPlanWorkspaceReport(report, args["show-paths"] === true),
        },
        args.json === true,
      )
      return
    }
    const applied = yield* Effect.tryPromise({
      try: () => applyWorkspaceMigration({ ...base, cleanupIds: ids }),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    print(
      { mode: "apply", result: applied, inventory: formatPlanWorkspaceReport(report, args["show-paths"] === true) },
      args.json === true,
    )
  }),
})

export const PlanWorkspacesCommand = cmd({
  command: "plan-workspaces",
  describe: "inspect and safely migrate plan workspace storage",
  builder: (yargs: Argv) => yargs.command(InspectCommand).command(CleanupCommand).demandCommand(),
  async handler() {},
})
