/**
 * Skill generator — creates SKILL.md files from learned instincts.
 *
 * Ported from claudecode's src/services/skillLearning/skillGenerator.ts.
 */
import { Effect, Context, Layer } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Global } from "@jyycode-ai/core/global"
import path from "path"
import {
  type Instinct,
  type LearnedSkillDraft,
  type LearnedAgentDraft,
  MIN_CONFIDENCE_TO_GENERATE,
  DUPLICATE_SKILL_OVERLAP_THRESHOLD,
  MAX_SKILL_FILE_BYTES,
  MAX_EVIDENCE_LINES_PER_APPEND,
} from "./types"

export interface Interface {
  /** Generate a skill draft from a set of instincts. */
  readonly generateSkillDraft: (instincts: Instinct[], scope?: "project" | "global") => Effect.Effect<LearnedSkillDraft | null>
  /** Write a learned skill to disk. */
  readonly writeSkill: (draft: LearnedSkillDraft) => Effect.Effect<string>
  /** Generate and write an agent definition. */
  readonly generateAgentDraft: (instincts: Instinct[], scope?: "project" | "global") => Effect.Effect<LearnedAgentDraft | null>
  /** Write a learned agent to disk. */
  readonly writeAgent: (draft: LearnedAgentDraft) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SkillGenerator") {}

const YAML_FRONTMATTER = (draft: LearnedSkillDraft) =>
  `---\nname: ${draft.name}\ndescription: ${draft.description}\norigin: skill-learning\nconfidence: ${draft.confidence.toFixed(2)}\ndomain: ${draft.domain}\n---\n\n`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const normalizeName = (value: string): string => {
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64)
    }

    const buildName = (instincts: Instinct[]): string => {
      const domainPrefix = instincts[0]?.domain ?? "workflow"
      const words = instincts
        .flatMap((i) => i.pattern.split(/\s+/))
        .filter((w) => w.length > 3)
        .slice(0, 3)
      return normalizeName(`${domainPrefix}-${words.join("-")}`) || `${domainPrefix}-learned-pattern`
    }

    const generateSkillDraft = Effect.fn("SkillGenerator.generateSkillDraft")(function* (
      instincts: Instinct[],
      scope: "project" | "global" = "project",
    ) {
      if (instincts.length === 0) return null

      const avgConfidence =
        instincts.reduce((sum, i) => sum + i.confidence, 0) / instincts.length
      if (avgConfidence < MIN_CONFIDENCE_TO_GENERATE) return null

      const name = buildName(instincts)
      const description = instincts[0]?.description ?? `Learned pattern: ${instincts[0]?.pattern ?? "unknown"}`
      const trigger = instincts.map((i) => i.pattern).join("; ")
      const action = instincts.map((i) => i.description).join("; ")
      const evidence = instincts.flatMap((i) =>
        i.evidence.map((e) => `[${e.toolName ?? "session"}] ${e.pattern}`),
      )

      return {
        name,
        description,
        scope,
        domain: instincts[0]?.domain ?? "project",
        confidence: avgConfidence,
        trigger,
        action,
        evidence: evidence.slice(0, MAX_EVIDENCE_LINES_PER_APPEND),
      } satisfies LearnedSkillDraft
    })

    const writeSkill = Effect.fn("SkillGenerator.writeSkill")(function* (draft: LearnedSkillDraft) {
      const dir =
        draft.scope === "project"
          ? path.join(process.cwd(), ".claude", "skills", draft.name)
          : path.join(Global.Path.config, "skills", draft.name)

      yield* fs.ensureDir(dir).pipe(Effect.orDie)

      const content = [
        YAML_FRONTMATTER(draft),
        `## Trigger\n${draft.trigger}\n\n`,
        `## Action\n${draft.action}\n\n`,
        `## Evidence\n${draft.evidence.map((e) => `- ${e}`).join("\n")}\n`,
      ].join("")

      if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_FILE_BYTES) {
        // Truncate evidence to fit
        const base = [YAML_FRONTMATTER(draft), `## Trigger\n${draft.trigger}\n\n`, `## Action\n${draft.action}\n\n`].join("")
        const remaining = MAX_SKILL_FILE_BYTES - Buffer.byteLength(base, "utf-8") - 100
        const truncatedEvidence = draft.evidence.slice(0, Math.max(1, Math.floor(remaining / 200)))
        const finalContent = base + `## Evidence\n${truncatedEvidence.map((e) => `- ${e}`).join("\n")}\n`
        yield* fs.writeFileString(path.join(dir, "SKILL.md"), finalContent).pipe(Effect.orDie)
      } else {
        yield* fs.writeFileString(path.join(dir, "SKILL.md"), content).pipe(Effect.orDie)
      }

      return path.join(dir, "SKILL.md")
    })

    const generateAgentDraft = Effect.fn("SkillGenerator.generateAgentDraft")(function* (
      instincts: Instinct[],
      scope: "project" | "global" = "project",
    ) {
      if (instincts.length === 0) return null

      const avgConfidence =
        instincts.reduce((sum, i) => sum + i.confidence, 0) / instincts.length
      if (avgConfidence < MIN_CONFIDENCE_TO_GENERATE) return null

      const name = `learned-agent-${buildName(instincts)}`
      const description = `Auto-generated agent for: ${instincts[0]?.description ?? "unknown pattern"}`
      const triggers = [...new Set(instincts.map((i) => i.pattern))]
      const playbook = [...new Set(instincts.map((i) => i.description))]
      const evidence = instincts.flatMap((i) =>
        i.evidence.map((e) => `[${e.toolName ?? "session"}] ${e.pattern}`),
      )

      return {
        name,
        description,
        scope,
        triggers,
        playbook,
        evidence,
      } satisfies LearnedAgentDraft
    })

    const writeAgent = Effect.fn("SkillGenerator.writeAgent")(function* (draft: LearnedAgentDraft) {
      const dir =
        draft.scope === "project"
          ? path.join(process.cwd(), ".claude", "agents")
          : path.join(Global.Path.config, "agents")

      yield* fs.ensureDir(dir).pipe(Effect.orDie)

      const content = [
        `---\nname: ${draft.name}\ndescription: ${draft.description}\norigin: skill-learning\n---\n\n`,
        `## Triggers\n${draft.triggers.map((t) => `- ${t}`).join("\n")}\n\n`,
        `## Playbook\n${draft.playbook.map((p) => `- ${p}`).join("\n")}\n\n`,
        `## Evidence\n${draft.evidence.map((e) => `- ${e}`).join("\n")}\n`,
      ].join("")

      const filePath = path.join(dir, `${draft.name}.md`)
      yield* fs.writeFileString(filePath, content).pipe(Effect.orDie)
      return filePath
    })

    return Service.of({ generateSkillDraft, writeSkill, generateAgentDraft, writeAgent })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))
