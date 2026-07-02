import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@jyycode-ai/core/util/log"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { mkdir } from "fs/promises"
import path from "path"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"

void Log.init({ print: false })
const it = testEffect(
  SessionNs.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
    Layer.provide(BackgroundJob.defaultLayer),
  ),
)

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

afterEach(async () => {
  await disposeAllInstances()
})

describe("session.list", () => {
  it.instance(
    "does not filter by directory when directory is omitted",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "jyycode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.use.list()).map((session) => session.id)
        expect(ids).toContain(root.id)
        expect(ids).toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by directory when directory is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "jyycode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: path.join(test.directory, "packages", "jyycode") }),
        )).map((session) => session.id)
        expect(ids).not.toContain(root.id)
        expect(ids).not.toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by path and ignores directory when path is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "jyycode", "src", "deep"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode", "src")),
        )
        const deeper = yield* withSession({ title: "deeper" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode", "src", "deep")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "app"),
            path: "packages/jyycode/src",
          }),
        )).map((session) => session.id)
        expect(pathIDs).not.toContain(parent.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).toContain(deeper.id)
        expect(pathIDs).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "falls back to directory when filtering legacy sessions without path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "jyycode", "src"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const current = yield* withSession({ title: "legacy-current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "jyycode", "src")),
        )
        const sibling = yield* withSession({ title: "legacy-sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, current.id)).run(),
          ),
        )
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sibling.id)).run(),
          ),
        )

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "jyycode", "src"),
            path: "packages/jyycode/src",
          }),
        )).map((session) => session.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters root sessions",
    () =>
      Effect.gen(function* () {
        const root = yield* withSession({ title: "root-session" })
        const child = yield* withSession({ title: "child-session", parentID: root.id })

        const sessions = yield* SessionNs.use.list({ roots: true })
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by start time",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "new-session" })
        const sessions = yield* SessionNs.Service.use((session) => session.list({ start: Date.now() + 86400000 }))
        expect(sessions.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "filters by search term",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "unique-search-term-abc" })
        yield* withSession({ title: "other-session-xyz" })

        const sessions = yield* SessionNs.use.list({ search: "unique-search" })
        const titles = sessions.map((session) => session.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      }),
    { git: true },
  )

  it.instance(
    "respects limit parameter",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "session-1" })
        yield* withSession({ title: "session-2" })
        yield* withSession({ title: "session-3" })

        const sessions = yield* SessionNs.use.list({ limit: 2 })
        expect(sessions.length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "matches Windows drive letters case-insensitively",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const created = yield* withSession({ title: "drive-case" })
        const lower = created.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const upper = lower.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
        yield* Effect.sync(() =>
          Database.Client().$client.prepare("UPDATE session SET directory = ? WHERE id = ?").run(lower, created.id),
        )
        const ids = (yield* SessionNs.use.list({ directory: upper })).map((session) => session.id)
        expect(ids).toContain(created.id)
      }),
    { git: true },
  )
})
