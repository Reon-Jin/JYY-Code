import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import { provideInstance, provideTmpdirInstance, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))
const itWithoutExternalSkills = testEffect(
  Layer.mergeAll(
    Skill.layer.pipe(
      Layer.provide(Discovery.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Global.layer),
      Layer.provide(RuntimeFlags.layer({ disableExternalSkills: true })),
    ),
    node,
  ),
)
const provenanceIt = testEffect(
  Layer.mergeAll(
    Skill.layer.pipe(
      Layer.provide(
        Layer.mock(Discovery.Service, {
          pull: (url) => {
            const root = new URL(url).searchParams.get("root")
            return Effect.succeed(root ? [root] : [])
          },
        }),
      ),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Global.layer),
      Layer.provide(RuntimeFlags.defaultLayer),
    ),
    node,
  ),
)

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".jyycode", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.jyycode/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.JYYCODE_TEST_HOME
      process.env.JYYCODE_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.JYYCODE_TEST_HOME = prev
      }),
  )

describe("skill", () => {
  it.instance("registers the built-in customization skill without legacy role skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const records = new Map((yield* skill.all()).map((record) => [record.name, record]))

      expect(records.get("customize-jyycode")).toMatchObject({ origin: "built_in", editable: false })
      expect(records.get("customize-jyycode")?.content).toContain("Project sub-agent profiles")
      expect(records.get("literature-review")).toBeUndefined()
      expect(records.get("code-review-and-quality")).toBeUndefined()
      expect(records.get("images-search")).toBeUndefined()
      expect(records.get("pdf")).toBeUndefined()
    }),
  )

  provenanceIt.instance(
    "tracks built-in, managed, path, and URL provenance with revisions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const suffix = path.basename(test.directory)
        const managedName = `managed-${suffix}`
        const pathName = `path-${suffix}`
        const urlName = `url-${suffix}`
        const managedDirectory = path.join(test.directory, ".jyycode", "skills", managedName)
        const pathRoot = path.join(test.directory, "configured-path")
        const urlRoot = path.join(test.directory, "remote-cache")
        const url = `https://skills.example.test/?root=${encodeURIComponent(urlRoot)}`
        const contents = {
          [managedName]: `---\nname: ${managedName}\ndescription: Managed\n---\n\n# Managed\n`,
          [pathName]: `---\nname: ${pathName}\ndescription: Path\n---\n\n# Path\n`,
          [urlName]: `---\nname: ${urlName}\ndescription: URL\n---\n\n# URL\n`,
        }

        yield* Effect.promise(async () => {
          await Promise.all([
            fs.mkdir(managedDirectory, { recursive: true }),
            fs.mkdir(path.join(pathRoot, pathName), { recursive: true }),
            fs.mkdir(path.join(urlRoot, urlName), { recursive: true }),
          ])
          await Promise.all([
            fs.writeFile(path.join(managedDirectory, "SKILL.md"), contents[managedName]),
            fs.writeFile(path.join(pathRoot, pathName, "SKILL.md"), contents[pathName]),
            fs.writeFile(path.join(urlRoot, urlName, "SKILL.md"), contents[urlName]),
            fs.writeFile(
              path.join(test.directory, "jyycode.json"),
              JSON.stringify({ skills: { paths: [pathRoot], urls: [url] } }),
            ),
          ])
        })
        const skill = yield* Skill.Service
        const records = yield* skill.all()
        const byName = new Map(records.map((record) => [record.name, record]))

        expect(byName.get("customize-jyycode")).toMatchObject({
          origin: "built_in",
          editable: false,
          deletable: false,
        })
        expect(byName.get(managedName)).toMatchObject({ origin: "managed", editable: true, deletable: true })
        expect(byName.get(pathName)).toMatchObject({
          origin: "path",
          source: pathRoot,
          editable: true,
          deletable: true,
        })
        expect(byName.get(urlName)).toMatchObject({ origin: "url", source: url, editable: false, deletable: true })

        for (const name of [managedName, pathName, urlName]) {
          expect(byName.get(name)?.revision).toBe(createHash("sha256").update(contents[name]).digest("hex"))
        }
        const builtIn = byName.get("customize-jyycode")!
        expect(builtIn.revision).toBe(createHash("sha256").update(builtIn.content).digest("hex"))
      }),
    { git: true },
  )

  it.live("discovers skills from .jyycode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".jyycode", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".jyycode", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".jyycode", "skill", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .jyycode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".jyycode", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".jyycode", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".jyycode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills without descriptions", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".jyycode", "skill", "manual-skill", "SKILL.md"),
              `---
name: manual-skill
---

# Manual Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "manual-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBeUndefined()
          expect(Skill.fmt(list, { verbose: false })).toBe("No skills are currently available.")
          expect(Skill.fmt(list, { verbose: true })).toBe("No skills are currently available.")
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .jyycode/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".jyycode", "skills", "jyycode-skill", "SKILL.md"),
              `---
name: jyycode-skill
description: A skill in the .jyycode/skills directory.
---

# JYYCode Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "jyycode-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".jyycode", "skills", "jyycode-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.jyycode/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-test-skill")
            expect(list[0].description).toBe("A global skill from ~/.jyycode/skills for testing.")
            expect(list[0].location).toContain(path.join(".jyycode", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("fails with typed error when requiring a missing skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const error = yield* Effect.flip(skill.require("missing-skill"))
          expect(error).toBeInstanceOf(Skill.NotFoundError)
          expect(error._tag).toBe("Skill.NotFoundError")
          expect(error.name).toBe("missing-skill")
          expect(error.message).toContain('Skill "missing-skill" not found.')
        }),
      { git: true },
    ),
  )

  it.effect("exposes tagged expected skill failure classes", () =>
    Effect.sync(() => {
      const invalid = new Skill.InvalidError({ path: "/tmp/SKILL.md", message: "Invalid skill frontmatter" })
      const mismatch = new Skill.NameMismatchError({
        path: "/tmp/SKILL.md",
        expected: "expected-skill",
        actual: "actual-skill",
      })

      expect(invalid).toBeInstanceOf(Skill.InvalidError)
      expect(invalid._tag).toBe("SkillInvalidError")
      expect(mismatch).toBeInstanceOf(Skill.NameMismatchError)
      expect(mismatch._tag).toBe("SkillNameMismatchError")
    }),
  )

  it.live("discovers multiple skills from .jyycode/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".jyycode", "skills", "jyycode-skill-a", "SKILL.md"),
                `---
name: jyycode-skill-a
description: First skill in .jyycode/skills directory.
---

# JYYCode Skill A
`,
              ),
              Bun.write(
                path.join(dir, ".jyycode", "skills", "jyycode-skill-b", "SKILL.md"),
                `---
name: jyycode-skill-b
description: Second skill in .jyycode/skills directory.
---

# JYYCode Skill B
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "jyycode-skill-a")).toBeDefined()
          expect(list.find((x) => x.name === "jyycode-skill-b")).toBeDefined()
        }),
      { git: true },
    ),
  )

  itWithoutExternalSkills.live("skips external skill directories when disabled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".jyycode", "skills", "external-skill", "SKILL.md"),
                `---
name: external-skill
description: A skill in the .jyycode/skills directory (external).
---

# External Skill
`,
              ),
              Bun.write(
                path.join(dir, ".jyycode", "skill", "jyycode-skill", "SKILL.md"),
                `---
name: jyycode-skill
description: A skill in the .jyycode/skill directory.
---

# JYYCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.map((s) => s.name)).toEqual(["jyycode-skill"])
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".jyycode", "skills", "jyycode-skills-dir", "SKILL.md"),
                `---
name: jyycode-skills-dir
description: A skill in the .jyycode/skills directory.
---

# JYYCode Skills Dir
`,
              ),
              Bun.write(
                path.join(dir, ".jyycode", "skill", "jyycode-skill-dir", "SKILL.md"),
                `---
name: jyycode-skill-dir
description: A skill in the .jyycode/skill directory.
---

# JYYCode Skill Dir
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(2)
        }),
      { git: true },
    ),
  )
})
