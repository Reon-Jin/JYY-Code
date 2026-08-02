import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { RoleSkillManagement } from "../../src/skill/role-management"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(RoleSkillManagement.defaultLayer, CrossSpawnSpawner.defaultLayer))

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.JYYCODE_TEST_HOME
      process.env.JYYCODE_TEST_HOME = home
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        process.env.JYYCODE_TEST_HOME = previous
      }),
  )

const content = "# Private skill\n\nUse this only for the assigned role.\n"

it.live(
  "writes canonical role skills and lists manual directories",
  provideTmpdirInstance(
    (directory) =>
      withHome(
        directory,
        Effect.gen(function* () {
          const management = yield* RoleSkillManagement.Service
          const created = yield* management.create("review", { name: "pdf", content })
          expect(created.id).toBe("role:review:pdf")
          expect(created.name).toBe("pdf")

          const file = path.join(directory, ".jyycode", "role", "review", "skills", "pdf", "SKILL.md")
          const written = yield* Effect.promise(() => Bun.file(file).text())
          expect(written).toContain("name: pdf")

          const manualDirectory = path.join(directory, ".jyycode", "role", "review", "skills", "manual")
          yield* Effect.promise(() => fs.mkdir(manualDirectory, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(manualDirectory, "SKILL.md"),
              "---\nname: manual\ndescription: Manual skill\n---\n\n# Manual\n",
            ),
          )

          const skills = yield* management.list("review")
          expect(skills.map((skill) => skill.name)).toEqual(["manual", "pdf"])
        }),
      ),
    { git: true },
  ),
)

it.live(
  "rejects unsafe paths, mismatched frontmatter, duplicates, and unknown role roots",
  provideTmpdirInstance(
    (directory) =>
      withHome(
        directory,
        Effect.gen(function* () {
          const management = yield* RoleSkillManagement.Service

          const unsafe = yield* management.create("../escape", { name: "pdf", content }).pipe(Effect.exit)
          expect(Exit.isFailure(unsafe)).toBe(true)

          const mismatched = yield* management
            .create("review", { name: "pdf", content: "---\nname: other\n---\n\n# Wrong\n" })
            .pipe(Effect.exit)
          expect(Exit.isFailure(mismatched)).toBe(true)

          yield* management.create("review", { name: "pdf", content })
          const duplicate = yield* management.create("review", { name: "pdf", content }).pipe(Effect.exit)
          expect(Exit.isFailure(duplicate)).toBe(true)

          const sameName = yield* management.create("general", { name: "pdf", content })
          expect(sameName.id).toBe("role:general:pdf")

          const error = yield* management.list("../escape").pipe(Effect.exit)
          expect(Exit.isFailure(error)).toBe(true)
          if (Exit.isFailure(error)) expect(Cause.squash(error.cause)).toBeInstanceOf(Error)
        }),
      ),
    { git: true },
  ),
)
