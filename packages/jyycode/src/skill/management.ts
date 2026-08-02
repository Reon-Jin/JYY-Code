import path from "path"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { Skill } from "."

const MAX_CONTENT_BYTES = 1024 * 1024
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export const CreateInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  content: Schema.String,
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const UpdateInput = Schema.Struct({
  content: Schema.String,
  revision: Schema.String,
})
export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>

export const SourceInput = Schema.Struct({
  type: Schema.Literals(["path", "url"]),
  value: Schema.String,
})
export type SourceInput = Schema.Schema.Type<typeof SourceInput>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SkillManagementNotFoundError", {
  name: Schema.String,
}) {}

export class ProtectedError extends Schema.TaggedErrorClass<ProtectedError>()("SkillManagementProtectedError", {
  name: Schema.String,
  origin: Skill.Origin,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SkillManagementConflictError", {
  name: Schema.String,
  latestRevision: Schema.String,
}) {}

export class InvalidContentError extends Schema.TaggedErrorClass<InvalidContentError>()(
  "SkillManagementInvalidContentError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

export class DuplicateError extends Schema.TaggedErrorClass<DuplicateError>()("SkillManagementDuplicateError", {
  name: Schema.String,
  location: Schema.optional(Schema.String),
}) {}

export class UnsafePathError extends Schema.TaggedErrorClass<UnsafePathError>()("SkillManagementUnsafePathError", {
  name: Schema.String,
  path: Schema.String,
}) {}

export type Error =
  | NotFoundError
  | ProtectedError
  | ConflictError
  | InvalidContentError
  | DuplicateError
  | UnsafePathError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Skill.Info, Error>
  readonly update: (name: string, input: UpdateInput) => Effect.Effect<Skill.Info, Error>
  readonly remove: (name: string) => Effect.Effect<{ changed: boolean }, Error>
  readonly addSource: (input: SourceInput) => Effect.Effect<{ info: Config.Info; changed: boolean }, Error>
  readonly removeSource: (input: SourceInput) => Effect.Effect<{ info: Config.Info; changed: boolean }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SkillManagement") {}

export function isSafeName(name: string) {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !RESERVED_WINDOWS_NAME.test(name)
  )
}

export function canonicalContent(input: CreateInput) {
  if (/^---\r?\n/.test(input.content)) return input.content
  const description = input.description === undefined ? "" : `description: ${yamlScalar(input.description)}\n`
  return `---\nname: ${input.name}\n${description}---\n\n${input.content}`
}

function yamlScalar(value: string) {
  return /^[^\s:#][^\r\n:#]*?(?: [^\r\n:#]+)*$/.test(value) ? value : JSON.stringify(value)
}

export function frontmatter(content: string, name: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return Effect.fail(new InvalidContentError({ name, message: "Skill content exceeds 1 MiB" }))
  }

  return Effect.try({
    try: () => ConfigMarkdown.parseContent(content, name),
    catch: (cause) =>
      new InvalidContentError({
        name,
        message: ConfigMarkdown.FrontmatterError.isInstance(cause)
          ? cause.data.message
          : `Failed to parse Skill frontmatter: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((parsed) => {
      if (!isRecord(parsed.data) || typeof parsed.data.name !== "string") {
        return Effect.fail(new InvalidContentError({ name, message: "Skill frontmatter must include a name" }))
      }
      if (parsed.data.name !== name) {
        return Effect.fail(new InvalidContentError({ name, message: `Skill frontmatter name must equal "${name}"` }))
      }
      if (parsed.data.description !== undefined && typeof parsed.data.description !== "string") {
        return Effect.fail(new InvalidContentError({ name, message: "Skill description must be a string" }))
      }
      return Effect.succeed({
        description: parsed.data.description as string | undefined,
      })
    }),
  )
}

export function contained(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function writeAtomic(fs: AppFileSystem.Interface, target: string, content: string) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  return fs.writeFileString(temp, content).pipe(
    Effect.flatMap(() => fs.rename(temp, target)),
    Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    Effect.orDie,
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const config = yield* Config.Service
    const skill = yield* Skill.Service
    const managedRoot = path.join(global.home, ".jyycode", "skills")

    const find = Effect.fn("SkillManagement.find")(function* (name: string) {
      const found = yield* skill.get(name)
      if (found) return found
      return yield* new NotFoundError({ name })
    })

    const configuredRoot = Effect.fn("SkillManagement.configuredRoot")(function* (source: string) {
      const directory = yield* InstanceState.directory
      const expanded = source.startsWith("~/") ? path.join(global.home, source.slice(2)) : source
      const absolute = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      return yield* fs
        .realPath(absolute)
        .pipe(Effect.mapError(() => new UnsafePathError({ name: source, path: absolute })))
    })

    const mutableFile = Effect.fn("SkillManagement.mutableFile")(function* (info: Skill.Info) {
      if (!info.editable || info.origin === "built_in" || info.origin === "url") {
        return yield* new ProtectedError({ name: info.name, origin: info.origin })
      }

      const realFile = yield* fs
        .realPath(info.location)
        .pipe(Effect.mapError(() => new UnsafePathError({ name: info.name, path: info.location })))

      if (info.origin === "managed") {
        yield* fs.makeDirectory(managedRoot, { recursive: true }).pipe(Effect.orDie)
        const realRoot = yield* fs.realPath(managedRoot).pipe(Effect.orDie)
        if (!contained(realRoot, realFile)) {
          return yield* new UnsafePathError({ name: info.name, path: realFile })
        }
        return { file: realFile, root: realRoot }
      }

      if (!info.source) return yield* new UnsafePathError({ name: info.name, path: realFile })
      const realRoot = yield* configuredRoot(info.source)
      if (!contained(realRoot, realFile)) {
        return yield* new UnsafePathError({ name: info.name, path: realFile })
      }
      return { file: realFile, root: realRoot }
    })

    const makeInfo = (
      name: string,
      description: string | undefined,
      location: string,
      content: string,
      origin: "managed" | "path",
      source?: string,
    ): Skill.Info => ({
      id: `global:${name}`,
      name,
      description,
      location,
      content,
      origin,
      source,
      ...Skill.capability[origin],
      revision: Skill.revision(content),
    })

    const create = Effect.fn("SkillManagement.create")(function* (input: CreateInput) {
      if (!isSafeName(input.name)) {
        return yield* new InvalidContentError({ name: input.name, message: "Invalid Skill name" })
      }

      const existing = yield* skill.get(input.name)
      if (existing) return yield* new DuplicateError({ name: input.name, location: existing.location })

      const content = canonicalContent(input)
      const parsed = yield* frontmatter(content, input.name)
      yield* fs.makeDirectory(managedRoot, { recursive: true }).pipe(Effect.orDie)
      const realRoot = yield* fs.realPath(managedRoot).pipe(Effect.orDie)
      const directory = path.join(realRoot, input.name)
      if (!contained(realRoot, directory) || (yield* fs.existsSafe(directory))) {
        return yield* new DuplicateError({ name: input.name, location: directory })
      }

      yield* fs.makeDirectory(directory).pipe(Effect.orDie)
      const realDirectory = yield* fs.realPath(directory).pipe(Effect.orDie)
      if (!contained(realRoot, realDirectory)) {
        return yield* new UnsafePathError({ name: input.name, path: realDirectory })
      }

      const target = path.join(realDirectory, "SKILL.md")
      yield* writeAtomic(fs, target, content)
      return makeInfo(input.name, parsed.description, target, content, "managed")
    })

    const update = Effect.fn("SkillManagement.update")(function* (name: string, input: UpdateInput) {
      if (!isSafeName(name)) return yield* new InvalidContentError({ name, message: "Invalid Skill name" })
      const info = yield* find(name)
      const target = yield* mutableFile(info)
      const current = yield* fs.readFileString(target.file).pipe(Effect.orDie)
      const latestRevision = Skill.revision(current)
      if (input.revision !== latestRevision) return yield* new ConflictError({ name, latestRevision })

      const parsed = yield* frontmatter(input.content, name)
      yield* writeAtomic(fs, target.file, input.content)
      const origin = info.origin === "path" ? "path" : "managed"
      return makeInfo(name, parsed.description, target.file, input.content, origin, info.source)
    })

    const sourceValues = Effect.fn("SkillManagement.sourceValues")(function* (type: SourceInput["type"]) {
      const info = yield* config.getGlobal()
      return { info, values: type === "path" ? (info.skills?.paths ?? []) : (info.skills?.urls ?? []) }
    })

    const addSource = Effect.fn("SkillManagement.addSource")(function* (input: SourceInput) {
      const value = input.value.trim()
      if (!value) return yield* new InvalidContentError({ name: input.value, message: "Skill source is required" })
      if (input.type === "url") {
        const valid = yield* Effect.sync(() => {
          try {
            return ["http:", "https:"].includes(new URL(value).protocol)
          } catch {
            return false
          }
        })
        if (!valid) return yield* new InvalidContentError({ name: value, message: "Invalid Skill source URL" })
      }

      const { info, values } = yield* sourceValues(input.type)
      if (values.some((item) => item.trim() === value)) return { info, changed: false }
      const key = input.type === "path" ? "paths" : "urls"
      return yield* config.updateGlobalPath(["skills", key], [...values, value])
    })

    const removeSource = Effect.fn("SkillManagement.removeSource")(function* (input: SourceInput) {
      const value = input.value.trim()
      const { info, values } = yield* sourceValues(input.type)
      const index = values.findIndex((item) => item === value)
      if (index === -1) return { info, changed: false }
      const next = values.toSpliced(index, 1)
      const key = input.type === "path" ? "paths" : "urls"
      return yield* config.updateGlobalPath(["skills", key], next)
    })

    const remove = Effect.fn("SkillManagement.remove")(function* (name: string) {
      if (!isSafeName(name)) return yield* new InvalidContentError({ name, message: "Invalid Skill name" })
      const info = yield* find(name)
      if (!info.deletable || info.origin === "built_in") {
        return yield* new ProtectedError({ name, origin: info.origin })
      }
      if (info.origin === "url") {
        if (!info.source) return yield* new UnsafePathError({ name, path: info.location })
        return yield* removeSource({ type: "url", value: info.source })
      }

      const target = yield* mutableFile(info)
      if (info.origin === "managed") {
        const directory = path.dirname(target.file)
        if (!contained(target.root, directory)) return yield* new UnsafePathError({ name, path: directory })
        yield* fs.remove(directory, { recursive: true }).pipe(Effect.orDie)
      } else {
        yield* fs.remove(target.file).pipe(Effect.orDie)
      }
      return { changed: true }
    })

    return Service.of({ create, update, remove, addSource, removeSource })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
)

export * as SkillManagement from "./management"
