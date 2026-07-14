import { afterEach, describe, expect, test } from "bun:test"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import fs from "fs/promises"
import path from "path"
import { disposeAllInstances, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { FileWatcher } from "../../src/file/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { pollWithTimeout, testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = Layer.mergeAll(
  Vcs.layer.pipe(Layer.provideMerge(Git.defaultLayer), Layer.provideMerge(Bus.layer)),
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
)
const it = testEffect(layer)

const gitResult = Effect.fn("VcsTest.gitResult")(function* (cwd: string, args: string[]) {
  return yield* Git.Service.use((git) => git.run(args, { cwd }))
})

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* gitResult(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const gitText = Effect.fn("VcsTest.gitText")(function* (cwd: string, args: string[]) {
  const result = yield* gitResult(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text().trim()
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* AppFileSystem.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* AppFileSystem.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const addFeatureRemote = Effect.fn("VcsTest.addFeatureRemote")(function* (directory: string, remote: string) {
  yield* git(remote, ["init", "--bare"])
  yield* git(directory, ["remote", "add", "origin", remote])
  yield* git(directory, ["push", "origin", "HEAD:refs/heads/feature/remote"])
  yield* git(directory, ["fetch", "origin"])
  yield* git(directory, ["remote", "set-head", "origin", "feature/remote"])
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const bus = yield* Bus.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* bus.subscribeCallback(Vcs.Event.BranchUpdated, (evt) => {
    Effect.runSync(Deferred.succeed(updated, evt.properties.branch))
  })
  yield* Effect.addFinalizer(() => Effect.sync(off))

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const bus = yield* Bus.Service
  for (let i = 0; i < 50; i++) {
    yield* bus.publish(FileWatcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "branches() lists local branches, remote branches, and remotes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["branch", "feature/local"])
        yield* addFeatureRemote(test.directory, remote)

        const vcs = yield* init()
        const result = yield* vcs.branches()

        expect(result).toEqual({
          current: "main",
          branches: [
            { name: "feature/local", kind: "local", current: false, updatedAt: expect.any(String) },
            { name: "main", kind: "local", current: true, updatedAt: expect.any(String) },
            {
              name: "origin/feature/remote",
              kind: "remote",
              remote: "origin",
              current: false,
              updatedAt: expect.any(String),
            },
          ],
          remotes: [{ name: "origin", fetchUrl: expect.any(String), pushUrl: expect.any(String) }],
        })
        expect(
          result.branches.every((branch) =>
            /^\d{4}-\d{2}-\d{2}T/.test((branch as { updatedAt?: string }).updatedAt ?? ""),
          ),
        ).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "creates and switches local and tracking branches with one event per operation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* addFeatureRemote(test.directory, remote)

        const vcs = yield* init()
        const bus = yield* Bus.Service
        let updates = 0
        const off = yield* bus.subscribeCallback(Vcs.Event.BranchUpdated, () => updates++)
        yield* Effect.addFinalizer(() => Effect.sync(off))

        const created = yield* vcs.createBranch({ name: "feature/gui", checkout: true })
        expect(created.current).toBe("feature/gui")

        const local = yield* vcs.switchBranch({ name: "main" })
        expect(local.current).toBe("main")

        const tracking = yield* vcs.switchBranch({ name: "origin/feature/remote", createLocal: true })
        expect(tracking.current).toBe("feature/remote")
        expect(tracking.branches).toContainEqual(
          expect.objectContaining({
            name: "feature/remote",
            kind: "local",
            current: true,
            upstream: "origin/feature/remote",
          }),
        )

        yield* pollWithTimeout(
          Effect.sync(() => (updates === 3 ? updates : undefined)),
          "branch update events were not published",
        )
        expect(updates).toBe(3)
      }),
    { git: true },
  )

  it.instance(
    "rejects invalid branch names",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const error = yield* Effect.flip(vcs.createBranch({ name: "bad branch", checkout: true }))

        expect(error.reason).toBe("invalid-name")
      }),
    { git: true },
  )

  it.instance(
    "keeps local changes when switching branches would overwrite them",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "conflict.txt")
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* write(file, "main\n")
        yield* git(test.directory, ["add", "conflict.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add conflict fixture"])
        yield* git(test.directory, ["switch", "-c", "conflict-target"])
        yield* write(file, "target\n")
        yield* git(test.directory, ["add", "conflict.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "change conflict fixture"])
        yield* git(test.directory, ["switch", "main"])
        yield* write(file, "local\n")

        const vcs = yield* init()
        const error = yield* Effect.flip(vcs.switchBranch({ name: "conflict-target" }))

        expect(error.reason).toBe("conflict")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("local\n")
        expect(yield* vcs.branch()).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "fetches all remotes and prunes stale remote branches",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(remote, ["init", "--bare"])
        yield* git(test.directory, ["remote", "add", "origin", remote])
        yield* git(test.directory, ["update-ref", "refs/remotes/origin/stale", "HEAD"])

        const vcs = yield* init()
        yield* vcs.fetch()

        const stale = yield* gitResult(test.directory, ["show-ref", "--verify", "refs/remotes/origin/stale"])
        expect(stale.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "pushes to the configured upstream remote before origin",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const origin = yield* tmpdirScoped()
        const upstream = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(origin, ["init", "--bare"])
        yield* git(upstream, ["init", "--bare"])
        yield* git(test.directory, ["remote", "add", "origin", origin])
        yield* git(test.directory, ["remote", "add", "upstream", upstream])
        yield* git(test.directory, ["push", "--set-upstream", "upstream", "main"])
        yield* write(path.join(test.directory, "upstream.txt"), "upstream\n")
        yield* git(test.directory, ["add", "upstream.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "update upstream"])

        const vcs = yield* init()
        yield* vcs.push()

        expect(yield* gitText(upstream, ["rev-parse", "refs/heads/main"])).toBe(
          yield* gitText(test.directory, ["rev-parse", "HEAD"]),
        )
        expect((yield* gitResult(origin, ["show-ref", "--verify", "refs/heads/main"])).exitCode).not.toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "uses origin and sets upstream for the first push",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(remote, ["init", "--bare"])
        yield* git(test.directory, ["remote", "add", "origin", remote])

        const vcs = yield* init()
        yield* vcs.push()

        expect(yield* gitText(test.directory, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/main")
      }),
    { git: true },
  )

  it.instance(
    "uses the only remote when origin is absent",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const remote = yield* tmpdirScoped()
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(remote, ["init", "--bare"])
        yield* git(test.directory, ["remote", "add", "backup", remote])

        const vcs = yield* init()
        yield* vcs.push()

        expect(yield* gitText(test.directory, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("backup/main")
      }),
    { git: true },
  )

  it.instance(
    "reports ambiguous non-origin remotes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const alpha = yield* tmpdirScoped()
        const beta = yield* tmpdirScoped()
        yield* git(alpha, ["init", "--bare"])
        yield* git(beta, ["init", "--bare"])
        yield* git(test.directory, ["remote", "add", "alpha", alpha])
        yield* git(test.directory, ["remote", "add", "beta", beta])

        const vcs = yield* init()
        const error = yield* Effect.flip(vcs.push())

        expect(error.reason).toBe("ambiguous-remote")
        expect(error.candidates).toEqual(["alpha", "beta"])
      }),
    { git: true },
  )

  it.instance(
    "reports a missing remote",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const error = yield* Effect.flip(vcs.push())

        expect(error.reason).toBe("missing-remote")
      }),
    { git: true },
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs push remote selection", () => {
  test("prefers upstream, then origin, then a sole remote", () => {
    const remotes = [{ name: "origin" }, { name: "upstream" }]
    expect(Vcs.selectPushRemote({ remotes, upstream: "upstream/main" })).toEqual({
      remote: "upstream",
      setUpstream: false,
    })
    expect(Vcs.selectPushRemote({ remotes })).toEqual({ remote: "origin", setUpstream: true })
    expect(Vcs.selectPushRemote({ remotes: [{ name: "backup" }] })).toEqual({
      remote: "backup",
      setUpstream: true,
    })
  })

  test("only asks for a remote when multiple non-origin remotes are available", () => {
    expect(Vcs.selectPushRemote({ remotes: [] })).toEqual({ reason: "missing-remote" })
    expect(Vcs.selectPushRemote({ remotes: [{ name: "beta" }, { name: "alpha" }] })).toEqual({
      reason: "ambiguous-remote",
      candidates: ["alpha", "beta"],
    })
  })
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  it.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
})
