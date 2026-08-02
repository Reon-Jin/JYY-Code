import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "memory",
        mutability: "read",
        risk: "medium",
        detail: "standard",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .requireAvailable(ctx.skillScope ?? Skill.rootScope, params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = info.origin === "built_in" ? undefined : path.dirname(info.location)
          const base = dir ? pathToFileURL(dir).href : `builtin://${info.name}`
          const files = dir
            ? yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
                Stream.filter((file) => !file.includes("SKILL.md")),
                Stream.map((file) => path.resolve(dir, file)),
                Stream.take(10),
                Stream.runCollect,
                Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
              )
            : "(built-in skill has no external resource directory)"

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              dir
                ? "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory."
                : "This built-in skill has no bundled external resource directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files,
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir: dir ?? "<built-in>",
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
