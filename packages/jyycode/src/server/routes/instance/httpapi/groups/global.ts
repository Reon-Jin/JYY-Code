import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

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
