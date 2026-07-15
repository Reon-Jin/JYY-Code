import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { ConfigMCP } from "@/config/mcp"
import * as InstanceState from "@/effect/instance-state"
import { SkillManagement } from "@/skill/management"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError } from "../errors"
import { markInstanceForDisposal } from "../lifecycle"
import {
  AddPayload,
  AuthCallbackPayload,
  ConfigMap,
  McpConfigInvalidError,
  StatusMap,
  UnsupportedOAuthError,
} from "../groups/mcp"

const isConfigured = (entry: unknown): entry is ConfigMCP.Info =>
  typeof entry === "object" && entry !== null && "type" in entry

const validateConfig = (name: string, value: ConfigMCP.Info) => {
  if (!SkillManagement.isSafeName(name)) return "Invalid MCP server name"
  if (value.type === "local") {
    if (value.command.length === 0 || value.command[0].trim() === "") return "Local MCP command is required"
    return undefined
  }
  try {
    const url = new URL(value.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Remote MCP URL must use HTTP or HTTPS"
  } catch {
    return "Remote MCP URL is invalid"
  }
  return undefined
}

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const configService = yield* Config.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const config = Effect.fn("McpHttpApi.config")(function* () {
      const global = yield* configService.getGlobal()
      return yield* Schema.decodeUnknownEffect(ConfigMap)(
        Object.fromEntries(Object.entries(global.mcp ?? {}).filter((entry) => isConfigured(entry[1]))),
      ).pipe(Effect.orDie)
    })

    const configUpdate = Effect.fn("McpHttpApi.configUpdate")(function* (ctx: {
      params: { name: string }
      payload: ConfigMCP.Info
    }) {
      const message = validateConfig(ctx.params.name, ctx.payload)
      if (message) {
        return yield* new McpConfigInvalidError({ name: "McpConfigInvalidError", data: { message } })
      }
      const result = yield* configService.updateGlobalPath(["mcp", ctx.params.name], ctx.payload)
      if (result.changed) yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const configDelete = Effect.fn("McpHttpApi.configDelete")(function* (ctx: { params: { name: string } }) {
      if (!SkillManagement.isSafeName(ctx.params.name)) {
        return yield* new McpConfigInvalidError({
          name: "McpConfigInvalidError",
          data: { message: "Invalid MCP server name" },
        })
      }

      const global = yield* configService.getGlobal()
      const entry = global.mcp?.[ctx.params.name]
      if (!isConfigured(entry)) {
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      }

      const statuses = yield* mcp.status()
      if (statuses[ctx.params.name]?.status === "connected") {
        yield* mcp.disconnect(ctx.params.name).pipe(Effect.catchTag("MCP.NotFoundError", () => Effect.void))
      }
      yield* mcp.removeAuth(ctx.params.name)
      const result = yield* configService.updateGlobalPath(["mcp", ctx.params.name], undefined)
      if (result.changed) yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp
        .finishAuth(ctx.params.name, ctx.payload.code)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .connect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    return handlers
      .handle("status", status)
      .handle("config", config)
      .handle("configUpdate", configUpdate)
      .handle("configDelete", configDelete)
      .handle("add", add)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
  }),
)
