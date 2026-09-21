import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Worktree } from "../../src/worktree"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Worktree.defaultLayer, CrossSpawnSpawner.defaultLayer))
const wintest = process.platform === "win32" ? it.live : it.live.skip

describe("Worktree.remove", () => {
  it.live("preserves an unrelated directory that is not a registered worktree", () =>
    provideTmpdirInstance(
      (root) =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const directory = path.join(root, "user-data")
          yield* Effect.promise(() => fs.mkdir(directory))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "keep.txt"), "keep"))
          const result = yield* Effect.exit(svc.remove({ directory }))
          expect(Exit.isFailure(result)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "keep.txt"), "utf8"))).toBe("keep")
          expect(Exit.isFailure(yield* Effect.exit(svc.remove({ directory: root })))).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("can finish removing an unregistered directory inside its managed root", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "cleanup-retry" })
          yield* Effect.promise(() => fs.mkdir(info.directory, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "leftover.txt"), "leftover"))
          expect(Exit.isFailure(yield* Effect.exit(svc.remove({ directory: path.dirname(info.directory) })))).toBe(true)
          expect(yield* svc.remove({ directory: info.directory })).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs.access(info.directory).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }),
      { git: true },
    ),
  )

  it.live("continues when git remove exits non-zero after detaching", () =>
    provideTmpdirInstance(
      (root) =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const name = `remove-regression-${Date.now().toString(36)}`
          const branch = `jyycode/${name}`
          const dir = path.join(root, "..", name)

          yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
          yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

          const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
          expect(real).toBeTruthy()

          const bin = path.join(root, "bin")
          const shim = path.join(bin, "git")
          yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              shim,
              [
                "#!/bin/bash",
                `REAL_GIT=${JSON.stringify(real)}`,
                'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
                '  "$REAL_GIT" "$@" >/dev/null 2>&1',
                '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
                "  exit 1",
                "fi",
                'exec "$REAL_GIT" "$@"',
              ].join("\n"),
            ),
          )
          yield* Effect.promise(() => fs.chmod(shim, 0o755))

          const prev = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const prev = process.env.PATH ?? ""
              process.env.PATH = `${bin}${path.delimiter}${prev}`
              return prev
            }),
            (prev) =>
              Effect.sync(() => {
                process.env.PATH = prev
              }),
          )
          void prev

          const ok = yield* svc.remove({ directory: dir })

          expect(ok).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(dir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)

          const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
          expect(list).not.toContain(`worktree ${dir}`)

          const ref = yield* Effect.promise(() =>
            $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
          )
          expect(ref.exitCode).not.toBe(0)
        }),
      { git: true },
    ),
  )

  wintest("stops fsmonitor before removing a worktree", () =>
    provideTmpdirInstance(
      (root) =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const name = `remove-fsmonitor-${Date.now().toString(36)}`
          const branch = `jyycode/${name}`
          const dir = path.join(root, "..", name)

          yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
          yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
          yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
          yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
          yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
          yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

          const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
          expect(before.exitCode).toBe(0)

          const ok = yield* svc.remove({ directory: dir })

          expect(ok).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(dir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)

          const ref = yield* Effect.promise(() =>
            $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
          )
          expect(ref.exitCode).not.toBe(0)
        }),
      { git: true },
    ),
  )
})
