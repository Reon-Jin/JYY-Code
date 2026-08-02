import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@jyycode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { SkillManagement } from "@/skill/management"
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

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const skillManagement = yield* SkillManagement.Service
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
