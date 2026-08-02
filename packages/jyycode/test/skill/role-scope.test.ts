import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import { Bus } from "../../src/bus"
import type { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const skillLayer = Skill.layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const it = testEffect(Layer.mergeAll(skillLayer, CrossSpawnSpawner.defaultLayer))

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

async function writeSkill(root: string, relative: string, name: string) {
  const directory = path.join(root, relative)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
  )
}

it.live(
  "isolates root and role skill catalogs",
  provideTmpdirInstance(
    (directory) =>
      withHome(
        directory,
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              writeSkill(directory, path.join(".jyycode", "skills", "global-only"), "global-only"),
              writeSkill(directory, path.join(".jyycode", "role", "review", "skills", "pdf"), "pdf"),
              writeSkill(directory, path.join(".jyycode", "role", "general", "skills", "check"), "check"),
            ]),
          )

          const skill = yield* Skill.Service
          expect(Global.Path.home).toBe(directory)
          const root = yield* skill.available(Skill.rootScope)
          const review = yield* skill.available(Skill.roleScope("review"))
          const general = yield* skill.available(Skill.roleScope("general"))
          const unknown = yield* skill.available(Skill.roleScope("unknown"))

          expect(root.map((item) => item.name)).toContain("customize-jyycode")
          expect(root.map((item) => item.name)).toContain("global-only")
          expect(root.map((item) => item.name)).not.toContain("pdf")
          expect(root.map((item) => item.name)).not.toContain("check")
          expect(review.map((item) => item.name)).toEqual(["pdf"])
          expect(general.map((item) => item.name)).toEqual(["check"])
          expect(unknown).toEqual([])

          const error = yield* skill.requireAvailable(Skill.roleScope("review"), "global-only").pipe(Effect.flip)
          expect(error).toBeInstanceOf(Skill.NotFoundError)
        }),
      ),
    { git: true },
  ),
)

it.effect("keeps primary identity from granting root scope to a child", () =>
  Effect.gen(function* () {
    const primary = {
      name: "build",
      mode: "primary",
      permission: Permission.fromConfig({ "*": "allow" }),
      options: {},
    } satisfies Agent.Info

    expect(Skill.scopeForSession({}, primary)).toEqual(Skill.rootScope)
    expect(Skill.scopeForSession({ parentID: "primary-session" }, primary)).toEqual(Skill.childScope())
    expect(
      Skill.scopeForSession(
        { parentID: "role-session" },
        { ...primary, options: { subagentProfileID: "review" } },
      ),
    ).toEqual(Skill.roleScope("review"))
  }),
)
