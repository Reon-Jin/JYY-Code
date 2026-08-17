import type { Argv } from "yargs"
import { Effect } from "effect"
import { BlobGarbageCollector } from "@/storage/blob-gc"
import { Global } from "@jyycode-ai/core/global"
import { CliError, effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"
import { maintainActiveDatabase, maintainDatabase } from "@/storage/maintenance"
import { inspectStorage, parseDuration, planCleanup } from "@/storage/retention"
import { BLOB_BACKFILL_DEFAULTS, runBlobBackfill } from "@/storage/blob-backfill"

function print(value: unknown, json: boolean) {
  process.stdout.write(`${json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`)
}

const InspectCommand = effectCmd({
  command: "inspect",
  describe: "inspect storage counts, bytes, and safety warnings without modifying it",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("root", { type: "string", description: "storage root override for diagnostics/tests" })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" }),
  handler: Effect.fn("Cli.storage.inspect")(function* (args) {
    const report = yield* Effect.tryPromise({
      try: () => inspectStorage(args.root ?? Global.Path.data),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    print(report, args.json === true)
  }),
})

const CleanupCommand = effectCmd({
  command: "cleanup",
  describe: "plan conservative retention cleanup; session deletion is never automatic",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("root", { type: "string", description: "storage root override for diagnostics/tests" })
      .option("dry-run", { type: "boolean", default: true, description: "report actions without changing storage" })
      .option("older-than", { type: "string", default: "30d", description: "terminal child retention window" })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" }),
  handler: Effect.fn("Cli.storage.cleanup")(function* (args) {
    let olderThanMs: number
    try {
      olderThanMs = parseDuration(args["older-than"])
    } catch (error) {
      return yield* Effect.fail(new CliError({ message: error instanceof Error ? error.message : String(error) }))
    }
    const plan = yield* Effect.tryPromise({
      try: () => planCleanup({ root: args.root ?? Global.Path.data, olderThanMs, dryRun: args["dry-run"] }),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    const gc = yield* new BlobGarbageCollector(args.root ?? Global.Path.data).run({
      dryRun: args["dry-run"],
      graceMs: olderThanMs,
    })
    print({ ...plan, blobGC: gc }, args.json === true)
  }),
})

const GCCommand = effectCmd({
  command: "gc",
  describe: "collect unreferenced content-addressed blobs and stale temporary files",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("root", { type: "string", description: "storage root override for diagnostics/tests" })
      .option("dry-run", {
        type: "boolean",
        default: true,
        description: "report collectable files without deleting them",
      })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" }),
  handler: Effect.fn("Cli.storage.gc")(function* (args) {
    const result = yield* new BlobGarbageCollector(args.root ?? Global.Path.data).run({ dryRun: args["dry-run"] })
    print(result, args.json === true)
  }),
})

const MaintainCommand = effectCmd({
  command: "maintain",
  describe: "checkpoint and incrementally vacuum SQLite within bounded limits",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("database", { type: "string", default: "active", description: "active or an offline database path" })
      .option("dry-run", {
        type: "boolean",
        default: true,
        description: "report maintenance without modifying the database",
      })
      .option("full", {
        type: "boolean",
        default: false,
        description: "explicitly request offline VACUUM INTO and atomic replacement",
      })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" }),
  handler: Effect.fn("Cli.storage.maintain")(function* (args) {
    const result =
      args.database === "active"
        ? yield* maintainActiveDatabase({ dryRun: args["dry-run"], full: args.full })
        : yield* Effect.tryPromise({
            try: () => maintainDatabase(args.database, { dryRun: args["dry-run"], full: args.full }),
            catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
          })
    print(result, args.json === true)
  }),
})

const BackfillCommand = effectCmd({
  command: "backfill",
  describe: "backfill legacy data URL attachments into content-addressed blobs",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("root", { type: "string", description: "storage root override for diagnostics/tests" })
      .option("dry-run", { type: "boolean", default: true, description: "report candidates without changing storage" })
      .option("batch-size", {
        type: "number",
        default: BLOB_BACKFILL_DEFAULTS.batchSize,
        description: "maximum parts per batch",
      })
      .option("batch-bytes", {
        type: "number",
        default: BLOB_BACKFILL_DEFAULTS.batchBytes,
        description: "maximum source bytes per batch",
      })
      .option("batch-timeout-ms", {
        type: "number",
        default: BLOB_BACKFILL_DEFAULTS.batchTimeoutMs,
        description: "maximum wall-clock time per batch",
      })
      .option("max-batches", { type: "number", description: "stop after this many batches so a run can be resumed" })
      .option("cursor", { type: "string", description: "cursor file override" })
      .option("reset", {
        type: "boolean",
        default: false,
        description: "ignore the existing cursor and start a new watermark",
      })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" }),
  handler: Effect.fn("Cli.storage.backfill")(function* (args) {
    const result = yield* runBlobBackfill({
      root: args.root ?? Global.Path.data,
      dryRun: args["dry-run"],
      batchSize: args["batch-size"],
      batchBytes: args["batch-bytes"],
      batchTimeoutMs: args["batch-timeout-ms"],
      maxBatches: args["max-batches"],
      cursorPath: args.cursor,
      reset: args.reset,
    })
    print(result, args.json === true)
  }),
})

export const StorageCommand = cmd({
  command: "storage",
  describe: "inspect and maintain session storage",
  builder: (yargs: Argv) =>
    yargs
      .command(InspectCommand)
      .command(CleanupCommand)
      .command(GCCommand)
      .command(MaintainCommand)
      .command(BackfillCommand)
      .demandCommand(),
  async handler() {},
})
