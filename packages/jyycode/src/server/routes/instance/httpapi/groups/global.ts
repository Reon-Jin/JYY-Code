import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { SessionID } from "@/session/schema"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

export const ManagementContext = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "ManagementContext" })

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([...BusEvent.effectPayloads(), ...SyncEvent.effectPayloads()]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

export const GlobalDefaultPermission = Schema.Struct({
  mode: Schema.Literals(["auto", "request", "full", "custom"]),
}).annotate({ identifier: "GlobalDefaultPermission" })

export const GlobalDefaultPermissionUpdate = Schema.Struct({
  mode: Schema.Literals(["auto", "request", "full"]),
})

const TailTurns = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 131072 }))
const TriggerRatio = Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 0.98 }))
const MicroCompactMaxChars = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 }))

export const GlobalCompaction = Schema.Struct({
  auto: Schema.Boolean,
  prune: Schema.Boolean,
  tailTurns: TailTurns,
  preserveRecentTokens: Schema.optional(TokenCount),
  reservedTokens: Schema.optional(TokenCount),
  triggerRatio: TriggerRatio,
  microCompact: Schema.Boolean,
  microCompactMaxChars: MicroCompactMaxChars,
  reactiveCompact: Schema.Boolean,
}).annotate({ identifier: "GlobalCompaction" })

export const GlobalMemoryScope = Schema.Literals(["user", "task", "experience"])
const MemoryImportance = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
const MemoryKeywords = Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(3))
const ExperienceKind = Schema.Literals(["success", "failure", "lesson"])
const ExperienceConfidence = Schema.Literals(["low", "medium", "high"])
const MemoryEntryInput = Schema.Struct({
  importance: MemoryImportance,
  keywords: MemoryKeywords,
  content: Schema.String,
})
const ExperienceMemoryInput = Schema.Struct({
  kind: ExperienceKind,
  importance: MemoryImportance,
  keywords: MemoryKeywords,
  content: Schema.String,
  confidence: ExperienceConfidence,
})
const GlobalUserMemoryEntry = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literal("user"),
  importance: MemoryImportance,
  date: Schema.optional(Schema.String),
  keywords: MemoryKeywords,
  content: Schema.String,
})
const GlobalTaskMemoryEntry = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literal("task"),
  importance: MemoryImportance,
  date: Schema.String,
  keywords: MemoryKeywords,
  content: Schema.String,
  projectID: Schema.optional(Schema.String),
  sessionID: SessionID,
})
const GlobalExperienceMemoryEntry = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literal("experience"),
  kind: ExperienceKind,
  importance: MemoryImportance,
  date: Schema.String,
  updatedAt: Schema.String,
  keywords: MemoryKeywords,
  content: Schema.String,
  evidence: Schema.String,
  confidence: ExperienceConfidence,
  uses: Schema.Int,
  status: Schema.Literals(["active", "superseded", "retracted"]),
  sessionID: SessionID,
  supersededReason: Schema.optional(Schema.String),
})
export const GlobalMemoryEntry = Schema.Union([
  GlobalUserMemoryEntry,
  GlobalTaskMemoryEntry,
  GlobalExperienceMemoryEntry,
]).annotate({
  identifier: "GlobalMemoryEntry",
})
export const GlobalMemoryPage = Schema.Struct({
  entries: Schema.Array(GlobalMemoryEntry),
  total: Schema.Int,
  nextCursor: Schema.optional(Schema.String),
}).annotate({ identifier: "GlobalMemoryPage" })
export const GlobalMemoryListQuery = Schema.Struct({
  scope: GlobalMemoryScope,
  sessionID: Schema.optional(SessionID),
  query: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})
export const GlobalMemoryOperationQuery = Schema.Struct({ sessionID: Schema.optional(SessionID) })
export const GlobalMemoryParams = { scope: GlobalMemoryScope, id: Schema.String }
export const GlobalMemoryScopeParams = { scope: GlobalMemoryScope }
export const GlobalMemoryEntryInput = MemoryEntryInput
export const GlobalMemoryUpdateInput = Schema.Union([MemoryEntryInput, ExperienceMemoryInput])
const StoredUserMemoryEntry = Schema.Struct({
  importance: MemoryImportance,
  date: Schema.optional(Schema.String),
  keywords: MemoryKeywords,
  content: Schema.String,
})
const StoredTaskMemoryEntry = Schema.Struct({
  sessionID: SessionID,
  importance: MemoryImportance,
  date: Schema.String,
  keywords: MemoryKeywords,
  content: Schema.String,
  projectID: Schema.optional(Schema.String),
})
const StoredExperienceMemoryEntry = Schema.Struct({
  kind: ExperienceKind,
  importance: MemoryImportance,
  date: Schema.String,
  updatedAt: Schema.String,
  keywords: MemoryKeywords,
  content: Schema.String,
  evidence: Schema.String,
  confidence: ExperienceConfidence,
  uses: Schema.Int,
  status: Schema.Literals(["active", "superseded", "retracted"]),
  sessionID: SessionID,
  supersededReason: Schema.optional(Schema.String),
})
export const GlobalMemoryExport = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  lastCompactedAt: Schema.NullOr(Schema.String),
  entries: Schema.Array(Schema.Union([StoredUserMemoryEntry, StoredTaskMemoryEntry])),
}).annotate({ identifier: "GlobalMemoryExport" })
export const GlobalExperienceMemoryExport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lastMaintainedAt: Schema.NullOr(Schema.String),
  entries: Schema.Array(StoredExperienceMemoryEntry),
}).annotate({ identifier: "GlobalExperienceMemoryExport" })
export const GlobalMemoryCompactResult = Schema.Struct({
  removed: Schema.Int,
  merged: Schema.Int,
  retained: Schema.Int,
}).annotate({ identifier: "GlobalMemoryCompactResult" })
export const GlobalMemoryRemoveResult = Schema.Struct({ removed: Schema.Boolean }).annotate({
  identifier: "GlobalMemoryRemoveResult",
})
export const GlobalMemoryClearResult = Schema.Struct({ removed: Schema.Int }).annotate({
  identifier: "GlobalMemoryClearResult",
})

export class GlobalMemoryBadRequestError extends Schema.TaggedErrorClass<GlobalMemoryBadRequestError>()(
  "GlobalMemoryBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class GlobalMemoryNotFoundError extends Schema.TaggedErrorClass<GlobalMemoryNotFoundError>()(
  "GlobalMemoryNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}
export class GlobalMemoryConflictError extends Schema.TaggedErrorClass<GlobalMemoryConflictError>()(
  "GlobalMemoryConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}
const GlobalMemoryErrors = [GlobalMemoryBadRequestError, GlobalMemoryNotFoundError, GlobalMemoryConflictError] as const

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  managementContext: "/global/management-context",
  defaultPermission: "/global/default-permission",
  compaction: "/global/compaction",
  memory: "/global/memory",
  memoryUser: "/global/memory/user",
  memoryEntry: "/global/memory/:scope/:id",
  memoryCompact: "/global/memory/:scope/compact",
  memoryTaskClear: "/global/memory/task/clear",
  memoryExport: "/global/memory/export",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the JYYCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the JYYCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(Config.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global JYYCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.get("managementContext", GlobalPaths.managementContext, {
        success: described(ManagementContext, "Global management context"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.managementContext",
          summary: "Get management context",
          description: "Return the authenticated backend home directory used for global management queries.",
        }),
      ),
      HttpApiEndpoint.get("defaultPermissionGet", GlobalPaths.defaultPermission, {
        success: described(GlobalDefaultPermission, "Global default permission policy"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.defaultPermission.get",
          summary: "Get default permission policy",
          description: "Return the default permission policy applied to new sessions.",
        }),
      ),
      HttpApiEndpoint.put("defaultPermissionUpdate", GlobalPaths.defaultPermission, {
        payload: GlobalDefaultPermissionUpdate,
        success: described(GlobalDefaultPermission, "Updated global default permission policy"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.defaultPermission.update",
          summary: "Update default permission policy",
          description: "Set the default permission policy applied to new sessions.",
        }),
      ),
      HttpApiEndpoint.get("compactionGet", GlobalPaths.compaction, {
        success: described(GlobalCompaction, "Global compaction settings"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.compaction.get",
          summary: "Get compaction settings",
          description: "Return the safe global context compaction settings.",
        }),
      ),
      HttpApiEndpoint.put("compactionUpdate", GlobalPaths.compaction, {
        payload: GlobalCompaction,
        success: described(GlobalCompaction, "Updated global compaction settings"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.compaction.update",
          summary: "Update compaction settings",
          description: "Replace the safe global context compaction settings.",
        }),
      ),
      HttpApiEndpoint.delete("compactionReset", GlobalPaths.compaction, {
        success: described(GlobalCompaction, "Default global compaction settings"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.compaction.reset",
          summary: "Reset compaction settings",
          description: "Remove only the global compaction override and return defaults.",
        }),
      ),
      HttpApiEndpoint.get("memoryList", GlobalPaths.memory, {
        query: GlobalMemoryListQuery,
        success: described(GlobalMemoryPage, "Memory entries"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.list",
          summary: "List persistent memories",
          description: "List a bounded page of user or task memories without exposing storage paths.",
        }),
      ),
      HttpApiEndpoint.post("memoryUserCreate", GlobalPaths.memoryUser, {
        payload: GlobalMemoryEntryInput,
        success: described(GlobalMemoryEntry, "Created user memory"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.user.create",
          summary: "Create user memory",
          description: "Create a validated persistent user memory entry.",
        }),
      ),
      HttpApiEndpoint.put("memoryUpdate", GlobalPaths.memoryEntry, {
        params: GlobalMemoryParams,
        query: GlobalMemoryOperationQuery,
        payload: GlobalMemoryUpdateInput,
        success: described(GlobalMemoryEntry, "Updated memory"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.update",
          summary: "Update memory",
          description: "Update one memory selected by its opaque id.",
        }),
      ),
      HttpApiEndpoint.delete("memoryRemove", GlobalPaths.memoryEntry, {
        params: GlobalMemoryParams,
        query: GlobalMemoryOperationQuery,
        success: described(GlobalMemoryRemoveResult, "Removed memory"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.remove",
          summary: "Remove memory",
          description: "Remove one memory selected by its opaque id.",
        }),
      ),
      HttpApiEndpoint.post("memoryCompact", GlobalPaths.memoryCompact, {
        params: GlobalMemoryScopeParams,
        query: GlobalMemoryOperationQuery,
        success: described(GlobalMemoryCompactResult, "Compaction result"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.compact",
          summary: "Compact memories",
          description:
            "Compact one memory scope using deterministic storage rules, across all task sessions when omitted.",
        }),
      ),
      HttpApiEndpoint.post("memoryTaskClear", GlobalPaths.memoryTaskClear, {
        query: GlobalMemoryOperationQuery,
        success: described(GlobalMemoryClearResult, "Task memories cleared"),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.task.clear",
          summary: "Clear task memory",
          description: "Clear task memory across all sessions, or one explicit session when provided.",
        }),
      ),
      HttpApiEndpoint.get("memoryExport", GlobalPaths.memoryExport, {
        query: GlobalMemoryListQuery,
        success: described(
          Schema.Union([GlobalMemoryExport, GlobalExperienceMemoryExport]),
          "Exported memory store",
        ),
        error: GlobalMemoryErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.memory.export",
          summary: "Export memories",
          description: "Export a normalized memory store for one scope across all matching sessions.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: Config.Info,
        success: described(Config.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global JYYCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all JYYCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade jyycode",
          description: "Upgrade jyycode to the specified version or latest if not specified.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
