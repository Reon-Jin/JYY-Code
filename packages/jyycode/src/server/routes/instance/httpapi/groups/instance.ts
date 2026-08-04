import { Agent } from "@/agent/agent"
import { SubagentProfile } from "@/agent/subagent-profile"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { SkillManagement } from "@/skill/management"
import { RoleSkillManagement } from "@/skill/role-management"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsOperationError extends Schema.ErrorClass<ApiVcsOperationError>("VcsOperationError")(
  {
    name: Schema.Literal("VcsOperationError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Vcs.OperationReason,
      candidates: Schema.optional(Schema.Array(Schema.String)),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiSkillInvalidError extends Schema.ErrorClass<ApiSkillInvalidError>("SkillInvalidError")(
  {
    name: Schema.Literal("SkillInvalidError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiSkillProtectedError extends Schema.ErrorClass<ApiSkillProtectedError>("SkillProtectedError")(
  {
    name: Schema.Literal("SkillProtectedError"),
    data: Schema.Struct({ message: Schema.String, skill: Schema.String }),
  },
  { httpApiStatus: 403 },
) {}

export class ApiSkillNotFoundError extends Schema.ErrorClass<ApiSkillNotFoundError>("SkillNotFoundError")(
  {
    name: Schema.Literal("SkillNotFoundError"),
    data: Schema.Struct({ message: Schema.String, skill: Schema.String }),
  },
  { httpApiStatus: 404 },
) {}

export class ApiSkillConflictError extends Schema.ErrorClass<ApiSkillConflictError>("SkillConflictError")(
  {
    name: Schema.Literal("SkillConflictError"),
    data: Schema.Struct({ message: Schema.String, skill: Schema.String, latestRevision: Schema.String }),
  },
  { httpApiStatus: 409 },
) {}

export class ApiSkillDuplicateError extends Schema.ErrorClass<ApiSkillDuplicateError>("SkillDuplicateError")(
  {
    name: Schema.Literal("SkillDuplicateError"),
    data: Schema.Struct({ message: Schema.String, skill: Schema.String, location: Schema.optional(Schema.String) }),
  },
  { httpApiStatus: 409 },
) {}

export class ApiSkillUnsafePathError extends Schema.ErrorClass<ApiSkillUnsafePathError>("SkillUnsafePathError")(
  {
    name: Schema.Literal("SkillUnsafePathError"),
    data: Schema.Struct({ message: Schema.String, skill: Schema.String, path: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiSubagentInvalidError extends Schema.ErrorClass<ApiSubagentInvalidError>("SubagentInvalidError")(
  {
    name: Schema.Literal("SubagentInvalidError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiSubagentNotFoundError extends Schema.ErrorClass<ApiSubagentNotFoundError>("SubagentNotFoundError")(
  {
    name: Schema.Literal("SubagentNotFoundError"),
    data: Schema.Struct({ message: Schema.String, roleID: Schema.String }),
  },
  { httpApiStatus: 404 },
) {}

export class ApiSubagentDuplicateError extends Schema.ErrorClass<ApiSubagentDuplicateError>("SubagentDuplicateError")(
  {
    name: Schema.Literal("SubagentDuplicateError"),
    data: Schema.Struct({ message: Schema.String, roleID: Schema.String, skill: Schema.String }),
  },
  { httpApiStatus: 409 },
) {}

export class ApiSubagentUnsafePathError extends Schema.ErrorClass<ApiSubagentUnsafePathError>(
  "SubagentUnsafePathError",
)(
  {
    name: Schema.Literal("SubagentUnsafePathError"),
    data: Schema.Struct({ message: Schema.String, roleID: Schema.String, path: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

const SkillMutationErrors = [
  ApiSkillInvalidError,
  ApiSkillProtectedError,
  ApiSkillNotFoundError,
  ApiSkillConflictError,
  ApiSkillDuplicateError,
  ApiSkillUnsafePathError,
] as const

const SubagentMutationErrors = [
  ApiSubagentInvalidError,
  ApiSubagentNotFoundError,
  ApiSubagentDuplicateError,
  ApiSubagentUnsafePathError,
] as const

export const SubagentProfileView = Schema.Struct({
  ...SubagentProfile.Profile.fields,
  skills: Schema.Array(Skill.Info),
}).annotate({ identifier: "SubagentProfileView" })

export const SubagentProfilesUpdate = Schema.Struct({
  profiles: Schema.mutable(Schema.Array(SubagentProfile.Profile)),
}).annotate({ identifier: "SubagentProfilesUpdate" })

export const SkillListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literal("global")),
  agent: Schema.optional(Schema.String),
})

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  vcsBranches: "/vcs/branches",
  vcsBranchCreate: "/vcs/branches",
  vcsBranchSwitch: "/vcs/branches/switch",
  vcsFetch: "/vcs/fetch",
  vcsPush: "/vcs/push",
  command: "/command",
  agent: "/agent",
  subagents: "/subagents",
  subagentRole: "/subagents/:roleID",
  subagentSkills: "/subagents/:roleID/skills",
  skill: "/skill",
  skillByName: "/skill/:name",
  skillSource: "/skill/source",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current JYYCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the JYYCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("vcsBranches", InstancePaths.vcsBranches, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Branches, "VCS branches and remotes"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.branch.list",
            summary: "List VCS branches",
            description: "List local and remote Git branches and configured remotes.",
          }),
        ),
        HttpApiEndpoint.post("vcsBranchCreate", InstancePaths.vcsBranchCreate, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.CreateBranchInput,
          success: described(Vcs.Branches, "Updated VCS branches and remotes"),
          error: ApiVcsOperationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.branch.create",
            summary: "Create VCS branch",
            description: "Create a local Git branch and optionally switch to it.",
          }),
        ),
        HttpApiEndpoint.post("vcsBranchSwitch", InstancePaths.vcsBranchSwitch, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.SwitchBranchInput,
          success: described(Vcs.Branches, "Updated VCS branches and remotes"),
          error: ApiVcsOperationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.branch.switch",
            summary: "Switch VCS branch",
            description: "Switch to a local branch or create a local branch tracking a remote branch.",
          }),
        ),
        HttpApiEndpoint.post("vcsFetch", InstancePaths.vcsFetch, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Branches, "Updated VCS branches and remotes"),
          error: ApiVcsOperationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.fetch",
            summary: "Fetch VCS remotes",
            description: "Fetch and prune all configured Git remotes.",
          }),
        ),
        HttpApiEndpoint.post("vcsPush", InstancePaths.vcsPush, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: Schema.UndefinedOr(Vcs.PushInput),
          success: described(Vcs.Branches, "Updated VCS branches and remotes"),
          error: ApiVcsOperationError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.push",
            summary: "Push VCS branch",
            description: "Push the current Git branch using its upstream or a selected remote.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the JYYCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the JYYCode system.",
          }),
        ),
        HttpApiEndpoint.get("subagents", InstancePaths.subagents, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SubagentProfileView), "List subagent profiles and private skills"),
          error: SubagentMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "subagents.list",
            summary: "List subagent profiles",
            description: "List global subagent profiles and the private skills discovered for each role.",
          }),
        ),
        HttpApiEndpoint.put("subagentsUpdate", InstancePaths.subagents, {
          query: WorkspaceRoutingQuery,
          payload: SubagentProfilesUpdate,
          success: described(Schema.Array(SubagentProfileView), "Updated subagent profiles"),
          error: SubagentMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "subagents.update",
            summary: "Replace subagent profiles",
            description: "Atomically replace the global subagent profile configuration.",
          }),
        ),
        HttpApiEndpoint.delete("subagentDelete", InstancePaths.subagentRole, {
          params: { roleID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SubagentProfileView), "Remaining subagent profiles"),
          error: SubagentMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "subagents.delete",
            summary: "Delete subagent profile",
            description: "Delete one subagent role together with its private skill directory.",
          }),
        ),
        HttpApiEndpoint.post("subagentSkillCreate", InstancePaths.subagentSkills, {
          params: { roleID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RoleSkillManagement.CreateInput,
          success: described(Skill.Info, "Private role skill created"),
          error: SubagentMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "subagents.skillCreate",
            summary: "Create private role skill",
            description: "Create a role-scoped SKILL.md under the selected subagent profile.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: SkillListQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the JYYCode system.",
          }),
        ),
        HttpApiEndpoint.post("skillCreate", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          payload: SkillManagement.CreateInput,
          success: described(Skill.Info, "Skill created"),
          error: SkillMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.create",
            summary: "Create Skill",
            description: "Create a globally managed Skill.",
          }),
        ),
        HttpApiEndpoint.put("skillUpdate", InstancePaths.skillByName, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SkillManagement.UpdateInput,
          success: described(Skill.Info, "Skill updated"),
          error: SkillMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.update",
            summary: "Update Skill",
            description: "Update editable Skill Markdown using its current revision.",
          }),
        ),
        HttpApiEndpoint.delete("skillDelete", InstancePaths.skillByName, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Skill deleted"),
          error: SkillMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.delete",
            summary: "Delete Skill",
            description: "Delete a local Skill or remove its synchronized source.",
          }),
        ),
        HttpApiEndpoint.post("skillSourceAdd", InstancePaths.skillSource, {
          query: WorkspaceRoutingQuery,
          payload: SkillManagement.SourceInput,
          success: described(Schema.Boolean, "Skill source added"),
          error: SkillMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.source.add",
            summary: "Add Skill source",
            description: "Add a global local-path or remote-URL Skill source.",
          }),
        ),
        HttpApiEndpoint.delete("skillSourceRemove", InstancePaths.skillSource, {
          query: WorkspaceRoutingQuery,
          payload: SkillManagement.SourceInput,
          success: described(Schema.Boolean, "Skill source removed"),
          error: SkillMutationErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "skill.source.remove",
            summary: "Remove Skill source",
            description: "Remove exactly one global local-path or remote-URL Skill source.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "jyycode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
