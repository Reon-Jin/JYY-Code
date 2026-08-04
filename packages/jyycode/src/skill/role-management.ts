import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import { Glob } from "@jyycode-ai/core/util/glob"
import { Skill } from "."
import { BuiltinRoles } from "./builtin-roles"
import { canonicalContent, contained, frontmatter, isSafeName, writeAtomic } from "./management"

export const CreateInput = Schema.Struct({
  name: Schema.String,
  content: Schema.String,
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export class InvalidRoleIDError extends Schema.TaggedErrorClass<InvalidRoleIDError>()(
  "RoleSkillManagementInvalidRoleIDError",
  { roleID: Schema.String },
) {}

export class InvalidContentError extends Schema.TaggedErrorClass<InvalidContentError>()(
  "RoleSkillManagementInvalidContentError",
  { name: Schema.String, message: Schema.String },
) {}

export class DuplicateError extends Schema.TaggedErrorClass<DuplicateError>()("RoleSkillManagementDuplicateError", {
  roleID: Schema.String,
  name: Schema.String,
}) {}

export class UnsafePathError extends Schema.TaggedErrorClass<UnsafePathError>()("RoleSkillManagementUnsafePathError", {
  roleID: Schema.String,
  path: Schema.String,
}) {}

export type Error = InvalidRoleIDError | InvalidContentError | DuplicateError | UnsafePathError

export interface Interface {
  readonly list: (roleID: string) => Effect.Effect<Skill.Info[], Error>
  readonly create: (roleID: string, input: CreateInput) => Effect.Effect<Skill.Info, Error>
  readonly remove: (roleID: string) => Effect.Effect<{ changed: boolean }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/RoleSkillManagement") {}

function safeRoleID(roleID: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(roleID)
}

function safeRoleSkillName(name: string) {
  return safeRoleID(name) && isSafeName(name)
}

function roleRoot(roleID: string) {
  return path.join(Global.Path.home, ".jyycode", "role", roleID, "skills")
}

function makeInfo(roleID: string, name: string, description: string | undefined, location: string, content: string) {
  return {
    id: `role:${roleID}:${name}`,
    name,
    description,
    location,
    content,
    origin: "role" as const,
    ...Skill.capability.role,
    revision: Skill.revision(content),
  } satisfies Skill.Info
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const list = Effect.fn("RoleSkillManagement.list")(function* (roleID: string) {
      if (!safeRoleID(roleID)) return yield* new InvalidRoleIDError({ roleID })
      yield* BuiltinRoles.seed(roleID, fs)
      const root = roleRoot(roleID)
      if (!(yield* fs.isDir(root))) return [] as Skill.Info[]

      const realRoot = yield* fs
        .realPath(root)
        .pipe(Effect.mapError(() => new UnsafePathError({ roleID, path: root })))
      const matches = yield* Effect.matchEffect(
        Effect.tryPromise({
          try: () => Glob.scan("**/SKILL.md", { cwd: root, absolute: true, include: "file", symlink: true, dot: true }),
          catch: (error) => error,
        }),
        {
          onFailure: () => Effect.succeed([] as string[]),
          onSuccess: (value) => Effect.succeed(value),
        },
      )

      const result: Skill.Info[] = []
      for (const match of matches) {
        const location = yield* fs
          .realPath(match)
          .pipe(Effect.mapError(() => new UnsafePathError({ roleID, path: match })))
        if (!contained(realRoot, location)) continue
        const name = path.basename(path.dirname(location))
        if (!safeRoleSkillName(name)) continue
        const raw = yield* fs.readFileString(location).pipe(Effect.option)
        if (Option.isNone(raw)) continue
        const parsed = yield* frontmatter(raw.value, name).pipe(Effect.option)
        if (Option.isNone(parsed)) continue
        result.push(makeInfo(roleID, name, parsed.value.description, location, raw.value))
      }

      return result.toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const create = Effect.fn("RoleSkillManagement.create")(function* (roleID: string, input: CreateInput) {
      if (!safeRoleID(roleID)) return yield* new InvalidRoleIDError({ roleID })
      if (!safeRoleSkillName(input.name)) {
        return yield* new InvalidContentError({ name: input.name, message: "Invalid Skill name" })
      }

      const root = roleRoot(roleID)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      const realRoot = yield* fs.realPath(root).pipe(Effect.orDie)
      const directory = path.join(realRoot, input.name)
      if (!contained(realRoot, directory)) return yield* new UnsafePathError({ roleID, path: directory })
      if (yield* fs.existsSafe(directory)) return yield* new DuplicateError({ roleID, name: input.name })

      const content = canonicalContent(input)
      const parsed = yield* frontmatter(content, input.name).pipe(
        Effect.mapError((error) => new InvalidContentError({ name: input.name, message: error.message })),
      )

      yield* fs.makeDirectory(directory).pipe(Effect.orDie)
      const realDirectory = yield* fs.realPath(directory).pipe(Effect.orDie)
      if (!contained(realRoot, realDirectory)) return yield* new UnsafePathError({ roleID, path: realDirectory })

      const target = path.join(realDirectory, "SKILL.md")
      yield* writeAtomic(fs, target, content)
      return makeInfo(roleID, input.name, parsed.description, target, content)
    })

    const remove = Effect.fn("RoleSkillManagement.remove")(function* (roleID: string) {
      if (!safeRoleID(roleID)) return yield* new InvalidRoleIDError({ roleID })
      const roleDirectory = path.dirname(roleRoot(roleID))
      if (!(yield* fs.isDir(roleDirectory))) return { changed: false }
      const realHome = yield* fs.realPath(Global.Path.home).pipe(Effect.orDie)
      const expected = path.join(realHome, ".jyycode", "role", roleID)
      const realDirectory = yield* fs
        .realPath(roleDirectory)
        .pipe(Effect.mapError(() => new UnsafePathError({ roleID, path: roleDirectory })))
      // Only ever delete the exact per-role directory; refuse symlink escapes.
      if (realDirectory !== expected) {
        return yield* new UnsafePathError({ roleID, path: realDirectory })
      }
      yield* fs.remove(realDirectory, { recursive: true, force: true }).pipe(Effect.orDie)
      return { changed: true }
    })

    return Service.of({ list, create, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Global.layer))

export * as RoleSkillManagement from "./role-management"
