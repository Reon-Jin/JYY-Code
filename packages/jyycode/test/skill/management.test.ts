import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { SkillManagement } from "@/skill/management"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import fs from "fs/promises"
import path from "path"

const configLayer = Config.defaultLayer
const skillLayer = Skill.layer.pipe(
  Layer.provide(
    Layer.mock(Discovery.Service, {
      pull: (url) => {
        const root = new URL(url).searchParams.get("root")
        return Effect.succeed(root ? [root] : [])
      },
    }),
  ),
  Layer.provide(configLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)
const managementLayer = SkillManagement.layer.pipe(
  Layer.provide(skillLayer),
  Layer.provide(configLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
)
const it = testEffect(Layer.mergeAll(managementLayer, skillLayer, configLayer, CrossSpawnSpawner.defaultLayer))

const markdown = (name: string, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}`

const writeSkill = async (directory: string, name: string, content = markdown(name)) => {
  const root = path.join(directory, name)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "SKILL.md"), content)
  return { root, file: path.join(root, "SKILL.md"), content }
}

describe.serial("SkillManagement", () => {
  it.instance("creates a managed Skill with canonical frontmatter", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const name = `created-${path.basename(test.directory)}`
      const managedRoot = path.join(Global.Path.home, ".jyycode", "skills")
      const target = path.join(managedRoot, name)
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(target, { recursive: true, force: true })))

      const management = yield* SkillManagement.Service
      const created = yield* management.create({ name, description: "Created skill", content: "# Body\n" })
      const source = yield* Effect.promise(() => fs.readFile(path.join(target, "SKILL.md"), "utf8"))

      expect(source).toBe(`---\nname: ${name}\ndescription: Created skill\n---\n\n# Body\n`)
      expect(created).toMatchObject({ name, origin: "managed", editable: true, deletable: true })
      expect(created.revision).toBe(Skill.revision(source))
    }),
  )

  it.instance("updates with the current revision and rejects a stale revision without replacing the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const name = `updated-${path.basename(test.directory)}`
      const fixture = yield* Effect.promise(() => writeSkill(path.join(Global.Path.home, ".jyycode", "skills"), name))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(fixture.root, { recursive: true, force: true })))

      const management = yield* SkillManagement.Service
      const current = (yield* (yield* Skill.Service).require(name)).revision
      const next = markdown(name, "# Updated\n")
      const updated = yield* management.update(name, { content: next, revision: current })
      const staleError = yield* Effect.flip(
        management.update(name, { content: markdown(name, "# Stale\n"), revision: current }),
      )

      expect(updated.revision).toBe(Skill.revision(next))
      expect(staleError).toBeInstanceOf(SkillManagement.ConflictError)
      expect((staleError as { latestRevision: string }).latestRevision).toBe(updated.revision)
      expect(yield* Effect.promise(() => fs.readFile(fixture.file, "utf8"))).toBe(next)
    }),
  )

  it.instance("removes only the managed directory or configured SKILL.md according to origin", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const suffix = path.basename(test.directory)
      const managedName = `managed-delete-${suffix}`
      const pathName = `path-delete-${suffix}`
      const managed = yield* Effect.promise(() =>
        writeSkill(path.join(Global.Path.home, ".jyycode", "skills"), managedName),
      )
      const configuredRoot = path.join(test.directory, "configured")
      const configured = yield* Effect.promise(() => writeSkill(configuredRoot, pathName))
      yield* Effect.promise(() => fs.writeFile(path.join(configured.root, "asset.txt"), "keep"))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(test.directory, "jyycode.json"),
          JSON.stringify({ skills: { paths: [configuredRoot] } }),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(managed.root, { recursive: true, force: true })))

      const management = yield* SkillManagement.Service
      yield* management.remove(managedName)
      yield* management.remove(pathName)

      expect(
        yield* Effect.promise(() =>
          fs.stat(managed.root).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(
        yield* Effect.promise(() =>
          fs.stat(configured.file).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(configured.root, "asset.txt"), "utf8"))).toBe("keep")
    }),
  )

  it.instance("protects built-in and URL-synchronized files", () =>
    Effect.gen(function* () {
      const management = yield* SkillManagement.Service
      const builtIn = yield* (yield* Skill.Service).require("customize-jyycode")

      const updateExit = yield* Effect.exit(
        management.update(builtIn.name, { content: builtIn.content, revision: builtIn.revision }),
      )
      const deleteExit = yield* Effect.exit(management.remove(builtIn.name))

      expect(updateExit._tag).toBe("Failure")
      expect(deleteExit._tag).toBe("Failure")
    }),
  )

  it.instance("trims and deduplicates path and URL sources and removes exactly one source", () =>
    Effect.gen(function* () {
      const configFile = path.join(Global.Path.config, "jyycode.jsonc")
      const before = yield* Effect.promise(() => fs.readFile(configFile, "utf8").catch(() => undefined))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (before === undefined) await fs.rm(configFile, { force: true })
          else await fs.writeFile(configFile, before)
        }),
      )
      yield* Effect.promise(() => fs.mkdir(Global.Path.config, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(configFile, "{}\n"))

      const management = yield* SkillManagement.Service
      const local = "C:/skills/example"
      const remote = "https://skills.example.test/"
      expect((yield* management.addSource({ type: "path", value: `  ${local}  ` })).changed).toBe(true)
      expect((yield* management.addSource({ type: "path", value: local })).changed).toBe(false)
      expect((yield* management.addSource({ type: "url", value: ` ${remote} ` })).changed).toBe(true)
      expect((yield* management.removeSource({ type: "path", value: local })).changed).toBe(true)

      const global = yield* (yield* Config.Service).getGlobal()
      expect(global.skills?.paths ?? []).toEqual([])
      expect(global.skills?.urls).toEqual([remote])
    }),
  )

  it.instance("removes a URL source instead of editing cached files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const name = `remote-${path.basename(test.directory)}`
      const remoteRoot = path.join(test.directory, "remote")
      const cached = yield* Effect.promise(() => writeSkill(remoteRoot, name))
      const url = `https://skills.example.test/?root=${encodeURIComponent(remoteRoot)}`
      const configFile = path.join(Global.Path.config, "jyycode.jsonc")
      const before = yield* Effect.promise(() => fs.readFile(configFile, "utf8").catch(() => undefined))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (before === undefined) await fs.rm(configFile, { force: true })
          else await fs.writeFile(configFile, before)
        }),
      )
      yield* Effect.promise(() => fs.mkdir(Global.Path.config, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(configFile, JSON.stringify({ skills: { urls: [url] } })))

      const management = yield* SkillManagement.Service
      yield* management.remove(name)
      const global = yield* (yield* Config.Service).getGlobal()

      expect(global.skills?.urls ?? []).toEqual([])
      expect(yield* Effect.promise(() => fs.readFile(cached.file, "utf8"))).toBe(cached.content)
    }),
  )

  it.instance("rejects duplicate, invalid, oversized, and symlink-escaped mutations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const name = `unsafe-${path.basename(test.directory)}`
      const managedRoot = path.join(Global.Path.home, ".jyycode", "skills")
      const outside = yield* Effect.promise(() => writeSkill(path.join(test.directory, "outside"), name))
      const link = path.join(managedRoot, name)
      yield* Effect.promise(async () => {
        await fs.mkdir(managedRoot, { recursive: true })
        await fs.symlink(outside.root, link, process.platform === "win32" ? "junction" : "dir")
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(link, { recursive: true, force: true })))

      const management = yield* SkillManagement.Service
      const info = yield* (yield* Skill.Service).require(name)
      const unsafe = yield* Effect.exit(management.update(name, { content: info.content, revision: info.revision }))
      const invalid = yield* Effect.exit(management.create({ name: "CON", content: "# Invalid" }))
      const oversized = yield* Effect.exit(
        management.create({ name: `large-${path.basename(test.directory)}`, content: "x".repeat(1024 * 1024 + 1) }),
      )
      const duplicate = yield* Effect.exit(management.create({ name, content: "# Duplicate" }))

      expect(unsafe._tag).toBe("Failure")
      expect(invalid._tag).toBe("Failure")
      expect(oversized._tag).toBe("Failure")
      expect(duplicate._tag).toBe("Failure")
    }),
  )
})
