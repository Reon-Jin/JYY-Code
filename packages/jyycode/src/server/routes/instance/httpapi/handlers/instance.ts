import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@jyycode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { SkillManagement } from "@/skill/management"
import { RoleSkillManagement } from "@/skill/role-management"
import { profileByID, resolveProfiles } from "@/agent/subagent-profile"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ApiSkillConflictError,
  ApiSkillDuplicateError,
  ApiSkillInvalidError,
  ApiSkillNotFoundError,
  ApiSkillProtectedError,
  ApiSkillUnsafePathError,
  ApiSubagentDuplicateError,
  ApiSubagentInvalidError,
  ApiSubagentNotFoundError,
  ApiSubagentUnsafePathError,
  SubagentProfilesUpdate,
  ApiVcsApplyError,
  ApiVcsOperationError,
} from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

const mapVcsOperationError = (error: Vcs.OperationError) =>
  new ApiVcsOperationError({
    name: "VcsOperationError",
    data: {
      message: error.message,
      reason: error.reason,
      ...(error.candidates ? { candidates: error.candidates } : {}),
    },
  })

const mapSkillError = (error: SkillManagement.Error) => {
  switch (error._tag) {
    case "SkillManagementInvalidContentError":
      return new ApiSkillInvalidError({
        name: "SkillInvalidError",
        data: { message: error.message },
      })
    case "SkillManagementProtectedError":
      return new ApiSkillProtectedError({
        name: "SkillProtectedError",
        data: { message: `Skill "${error.name}" is protected`, skill: error.name },
      })
    case "SkillManagementNotFoundError":
      return new ApiSkillNotFoundError({
        name: "SkillNotFoundError",
        data: { message: `Skill "${error.name}" was not found`, skill: error.name },
      })
    case "SkillManagementConflictError":
      return new ApiSkillConflictError({
        name: "SkillConflictError",
        data: {
          message: `Skill "${error.name}" changed since it was read`,
          skill: error.name,
          latestRevision: error.latestRevision,
        },
      })
    case "SkillManagementDuplicateError":
      return new ApiSkillDuplicateError({
        name: "SkillDuplicateError",
        data: {
          message: `Skill "${error.name}" already exists`,
          skill: error.name,
          location: error.location,
        },
      })
    case "SkillManagementUnsafePathError":
      return new ApiSkillUnsafePathError({
        name: "SkillUnsafePathError",
        data: { message: `Unsafe Skill path for "${error.name}"`, skill: error.name, path: error.path },
      })
  }
}

const mapSubagentError = (error: RoleSkillManagement.Error) => {
  switch (error._tag) {
    case "RoleSkillManagementInvalidRoleIDError":
      return new ApiSubagentInvalidError({
        name: "SubagentInvalidError",
        data: { message: `Invalid subagent role ID: ${error.roleID}` },
      })
    case "RoleSkillManagementInvalidContentError":
      return new ApiSubagentInvalidError({
        name: "SubagentInvalidError",
        data: { message: error.message },
      })
    case "RoleSkillManagementDuplicateError":
      return new ApiSubagentDuplicateError({
        name: "SubagentDuplicateError",
        data: {
          message: `Private skill "${error.name}" already exists for role "${error.roleID}"`,
          roleID: error.roleID,
          skill: error.name,
        },
      })
    case "RoleSkillManagementUnsafePathError":
      return new ApiSubagentUnsafePathError({
        name: "SubagentUnsafePathError",
        data: {
          message: `Unsafe private skill path for role "${error.roleID}"`,
          roleID: error.roleID,
          path: error.path,
        },
      })
  }
}

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const skillManagement = yield* SkillManagement.Service
    const roleSkillManagement = yield* RoleSkillManagement.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getVcsBranches = Effect.fn("InstanceHttpApi.vcsBranches")(function* () {
      return yield* vcs.branches()
    })

    const createVcsBranch = Effect.fn("InstanceHttpApi.vcsBranchCreate")(function* (ctx: {
      payload: Vcs.CreateBranchInput
    }) {
      return yield* vcs.createBranch(ctx.payload).pipe(Effect.mapError(mapVcsOperationError))
    })

    const switchVcsBranch = Effect.fn("InstanceHttpApi.vcsBranchSwitch")(function* (ctx: {
      payload: Vcs.SwitchBranchInput
    }) {
      return yield* vcs.switchBranch(ctx.payload).pipe(Effect.mapError(mapVcsOperationError))
    })

    const fetchVcs = Effect.fn("InstanceHttpApi.vcsFetch")(function* () {
      return yield* vcs.fetch().pipe(Effect.mapError(mapVcsOperationError))
    })

    const pushVcs = Effect.fn("InstanceHttpApi.vcsPush")(function* (ctx: { payload: Vcs.PushInput | undefined }) {
      return yield* vcs.push(ctx.payload).pipe(Effect.mapError(mapVcsOperationError))
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const profiles = Effect.fn("InstanceHttpApi.subagentProfiles")(function* () {
      const global = yield* config.getGlobal()
      const current = global.subagents !== undefined ? global : yield* config.get()
      try {
        const resolved = resolveProfiles(current.subagents?.profiles)
        if (global.subagents === undefined && current.subagents !== undefined) {
          yield* config.updateGlobal({ subagents: { profiles: resolved } })
          yield* config.updateProject({ subagents: undefined })
          yield* markInstanceForDisposal(yield* InstanceState.context)
        }
        return resolved
      } catch (error) {
        return yield* new ApiSubagentInvalidError({
          name: "SubagentInvalidError",
          data: { message: error instanceof Error ? error.message : String(error) },
        })
      }
    })

    const profileViews = Effect.fn("InstanceHttpApi.subagentProfileViews")(function* (
      resolved: ReturnType<typeof resolveProfiles>,
    ) {
      const result = []
      for (const profile of resolved) {
        const skills = yield* roleSkillManagement.list(profile.id).pipe(Effect.mapError(mapSubagentError))
        result.push({ ...profile, skills })
      }
      return result
    })

    const getSubagents = Effect.fn("InstanceHttpApi.subagentsList")(function* () {
      return yield* profileViews(yield* profiles())
    })

    const updateSubagents = Effect.fn("InstanceHttpApi.subagentsUpdate")(function* (ctx: {
      payload: typeof SubagentProfilesUpdate.Type
    }) {
      let resolved: ReturnType<typeof resolveProfiles>
      try {
        resolved = resolveProfiles(ctx.payload.profiles as readonly unknown[])
      } catch (error) {
        return yield* new ApiSubagentInvalidError({
          name: "SubagentInvalidError",
          data: { message: error instanceof Error ? error.message : String(error) },
        })
      }
      yield* config.updateGlobal({ subagents: { profiles: resolved } })
      yield* config.updateProject({ subagents: undefined })
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return yield* profileViews(resolved)
    })

    const createSubagentSkill = Effect.fn("InstanceHttpApi.subagentsSkillCreate")(function* (ctx: {
      params: { roleID: string }
      payload: RoleSkillManagement.CreateInput
    }) {
      const resolved = yield* profiles()
      if (!profileByID(resolved, ctx.params.roleID)) {
        return yield* new ApiSubagentNotFoundError({
          name: "SubagentNotFoundError",
          data: { message: `Subagent role "${ctx.params.roleID}" was not found`, roleID: ctx.params.roleID },
        })
      }
      const result = yield* roleSkillManagement.create(ctx.params.roleID, ctx.payload).pipe(
        Effect.mapError(mapSubagentError),
      )
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return result
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* (ctx: { query: { agent?: string } }) {
      if (!ctx.query.agent) return yield* skill.all()
      return yield* skill.available(Skill.rootScope, yield* agent.get(ctx.query.agent))
    })

    const markMutation = Effect.fn("InstanceHttpApi.markSkillMutation")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
    })

    const createSkill = Effect.fn("InstanceHttpApi.skillCreate")(function* (ctx: {
      payload: SkillManagement.CreateInput
    }) {
      const result = yield* skillManagement.create(ctx.payload).pipe(Effect.mapError(mapSkillError))
      yield* markMutation()
      return result
    })

    const updateSkill = Effect.fn("InstanceHttpApi.skillUpdate")(function* (ctx: {
      params: { name: string }
      payload: SkillManagement.UpdateInput
    }) {
      const result = yield* skillManagement.update(ctx.params.name, ctx.payload).pipe(Effect.mapError(mapSkillError))
      yield* markMutation()
      return result
    })

    const deleteSkill = Effect.fn("InstanceHttpApi.skillDelete")(function* (ctx: { params: { name: string } }) {
      const result = yield* skillManagement.remove(ctx.params.name).pipe(Effect.mapError(mapSkillError))
      if (result.changed) yield* markMutation()
      return result.changed
    })

    const addSkillSource = Effect.fn("InstanceHttpApi.skillSourceAdd")(function* (ctx: {
      payload: SkillManagement.SourceInput
    }) {
      const result = yield* skillManagement.addSource(ctx.payload).pipe(Effect.mapError(mapSkillError))
      if (result.changed) yield* markMutation()
      return result.changed
    })

    const removeSkillSource = Effect.fn("InstanceHttpApi.skillSourceRemove")(function* (ctx: {
      payload: SkillManagement.SourceInput
    }) {
      const result = yield* skillManagement.removeSource(ctx.payload).pipe(Effect.mapError(mapSkillError))
      if (result.changed) yield* markMutation()
      return result.changed
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("vcsBranches", getVcsBranches)
      .handle("vcsBranchCreate", createVcsBranch)
      .handle("vcsBranchSwitch", switchVcsBranch)
      .handle("vcsFetch", fetchVcs)
      .handle("vcsPush", pushVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("subagents", getSubagents)
      .handle("subagentsUpdate", updateSubagents)
      .handle("subagentSkillCreate", createSubagentSkill)
      .handle("skill", getSkill)
      .handle("skillCreate", createSkill)
      .handle("skillUpdate", updateSkill)
      .handle("skillDelete", deleteSkill)
      .handle("skillSourceAdd", addSkillSource)
      .handle("skillSourceRemove", removeSkillSource)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
