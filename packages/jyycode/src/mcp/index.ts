import { dynamicTool, type Tool as AITool, jsonSchema, type JSONSchema7 } from "ai"
import { serviceUse } from "@/effect/service-use"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCP } from "../config/mcp"
import * as Log from "@jyycode-ai/core/util/log"
import { NamedError } from "@jyycode-ai/core/util/error"
import { InstallationVersion } from "@jyycode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Tool as JYYTool } from "@/tool/tool"
import { ContentLimits, ensureBase64WithinLimit } from "@/tool/content-limits"
import {
  identifyTool,
  providerSafeToolName,
  resolveToolModelNames,
  type ToolIdentity,
  type IdentifiedToolDef,
} from "@/tool/identity"
import { MCPServerManager } from "./manager"
import { createStderrPolicy } from "./stderr-policy"

const log = Log.create({ service: "mcp" })
export const DEFAULT_MCP_IDLE_TIMEOUT = 60_000
export const MAX_MCP_IDLE_TIMEOUT = 120_000
export const DEFAULT_MCP_TOTAL_TIMEOUT = 300_000
export const MAX_MCP_TOTAL_TIMEOUT = 600_000
// Tool discovery is an optional dependency of the UI catalog and the agent
// prompt. It must not inherit the multi-minute budget intended for an actual
// MCP tool invocation, otherwise a temporarily unreachable server blocks the
// whole workspace surface.
export const DEFAULT_MCP_DISCOVERY_TIMEOUT = 15_000
const MCP_CLOSE_GRACE_MS = 3_000

export interface McpTimeouts {
  readonly idleMs: number
  readonly totalMs: number
}

export interface McpTimeoutInput {
  readonly timeout?: number
  readonly idle_timeout_ms?: number
  readonly total_timeout_ms?: number
}

export interface McpTimeoutDefaults {
  readonly idleMs?: number
  readonly totalMs?: number
}

export function resolveMcpDiscoveryTimeouts(timeouts: McpTimeouts, maxMs = DEFAULT_MCP_DISCOVERY_TIMEOUT): McpTimeouts {
  const totalMs = Math.max(1, Math.min(timeouts.totalMs, maxMs))
  return { idleMs: Math.min(timeouts.idleMs, totalMs), totalMs }
}

export function resolveMcpTimeouts(input: McpTimeoutInput = {}, defaults: McpTimeoutDefaults = {}): McpTimeouts {
  const idleMs = Math.min(
    input.idle_timeout_ms ?? input.timeout ?? defaults.idleMs ?? DEFAULT_MCP_IDLE_TIMEOUT,
    MAX_MCP_IDLE_TIMEOUT,
  )
  const totalMs = Math.min(input.total_timeout_ms ?? defaults.totalMs ?? DEFAULT_MCP_TOTAL_TIMEOUT, MAX_MCP_TOTAL_TIMEOUT)
  if (totalMs < idleMs) {
    throw new Error(`MCP total timeout (${totalMs}ms) must be greater than or equal to idle timeout (${idleMs}ms)`)
  }
  return { idleMs, totalMs }
}

function remainingMcpTimeouts(timeouts: McpTimeouts, deadlineAt: number): McpTimeouts {
  const totalMs = Math.max(1, deadlineAt - Date.now())
  return { idleMs: Math.min(timeouts.idleMs, totalMs), totalMs }
}

export function withMcpRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeouts: McpTimeouts,
  label: string,
  deadlineAt = Date.now() + timeouts.totalMs,
): Promise<T> {
  const effective = remainingMcpTimeouts(timeouts, deadlineAt)
  const controller = new AbortController()
  const promise = Promise.resolve().then(() => request(controller.signal))
  return withTimeout(promise, effective.totalMs, `${label} timed out after ${effective.totalMs}ms`).catch((error) => {
    controller.abort(error)
    throw error
  })
}

export function mcpRequestOptions(timeouts: McpTimeouts, signal: AbortSignal, onprogress?: (progress: unknown) => void) {
  return {
    timeout: timeouts.idleMs,
    maxTotalTimeout: timeouts.totalMs,
    resetTimeoutOnProgress: true,
    signal,
    ...(onprogress ? { onprogress } : {}),
  }
}

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({
    server: Schema.String,
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  Schema.Struct({
    mcpName: Schema.String,
    url: Schema.String,
  }),
)

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry | undefined): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = providerSafeToolName

function mcpInputSchema(inputSchema: unknown): JSONSchema7 {
  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    throw new Error("MCP tool input schema must be a JSON Schema object")
  }
  const schema = { ...(inputSchema as JSONSchema7) }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error(`MCP tool input schema must describe an object, got ${String(schema.type)}`)
  }
  // MCP tool arguments are objects, but preserve every provider-supported and
  // provider-unknown keyword from the server schema verbatim.
  if (schema.type === undefined) schema.type = "object"
  return schema
}

function remoteURL(key: string, value: string) {
  if (URL.canParse(value)) return new URL(value)
  log.warn("invalid remote mcp url", { key })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function listTools(key: string, client: MCPClient, timeouts: McpTimeouts) {
  const deadlineAt = Date.now() + timeouts.totalMs
  return Effect.tryPromise({
    try: (signal) => withMcpRequest((requestSignal) => client.listTools(undefined, mcpRequestOptions(remainingMcpTimeouts(timeouts, deadlineAt), requestSignal)), timeouts, `MCP ${key} tools/list`, deadlineAt),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key, error })
      return Effect.tryPromise({
        try: (signal) =>
          withMcpRequest(
            (requestSignal) =>
              client.request(
                { method: "tools/list" },
                TolerantListToolsResultSchema,
                mcpRequestOptions(remainingMcpTimeouts(timeouts, deadlineAt), requestSignal),
              ),
            timeouts,
            `MCP ${key} tools/list retry`,
            deadlineAt,
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((result) =>
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      )
    }),
  )
}

// Convert MCP tool definition to AI SDK Tool type
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeouts: McpTimeouts): AITool {
  const schema = mcpInputSchema(mcpTool.inputSchema)

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return withMcpRequest(
        (signal) =>
          client.callTool(
            {
              name: mcpTool.name,
              arguments: (args || {}) as Record<string, unknown>,
            },
            CallToolResultSchema,
            mcpRequestOptions(timeouts, signal),
          ),
        timeouts,
        `MCP tool ${mcpTool.name}`,
      )
    },
  })
}

const McpToolParameters = Schema.Record(Schema.String, Schema.Unknown)

function convertMcpToolDef(
  clientName: string,
  mcpTool: MCPToolDef,
  client: MCPClient,
  timeouts: McpTimeouts,
): JYYTool.Def<typeof McpToolParameters> & { identity: ToolIdentity } {
  const id = sanitize(clientName) + "_" + sanitize(mcpTool.name)
  const schema = mcpInputSchema(mcpTool.inputSchema)
  const identity: ToolIdentity = {
    source: "mcp",
    sourceID: `mcp:${clientName}\0${mcpTool.name}`,
    modelName: id,
  }
  const readOnly = mcpTool.annotations?.readOnlyHint === true

  return identifyTool(
    {
      id,
      description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${clientName}`,
      parameters: McpToolParameters,
      jsonSchema: schema,
      catalog: {
        category: "mcp",
        mutability: readOnly ? "read" : "external",
        risk: readOnly ? "low" : "high",
        tags: [clientName, mcpTool.name, "mcp"],
      },
      execute: (args, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: id, metadata: {}, patterns: ["*"], always: ["*"] })
          const result = (yield* Effect.tryPromise({
            try: (signal) =>
              withMcpRequest(
                (requestSignal) =>
                  client.callTool(
                    {
                      name: mcpTool.name,
                      arguments: (args || {}) as Record<string, unknown>,
                    },
                    CallToolResultSchema,
                    mcpRequestOptions(timeouts, requestSignal),
                  ),
                timeouts,
                `MCP tool ${mcpTool.name}`,
              ),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(Effect.orDie)) as Awaited<ReturnType<MCPClient["callTool"]>>

          const textParts: string[] = []
          const attachments: NonNullable<JYYTool.ExecuteResult["attachments"]> = []
          for (const contentItem of result.content as any[]) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              yield* ensureBase64WithinLimit(contentItem.data, ContentLimits.mcpAttachmentBytes, "MCP image").pipe(
                Effect.orDie,
              )
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if ("text" in resource && resource.text) textParts.push(resource.text)
              if ("blob" in resource && resource.blob) {
                yield* ensureBase64WithinLimit(
                  resource.blob,
                  ContentLimits.mcpAttachmentBytes,
                  "MCP resource blob",
                ).pipe(Effect.orDie)
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          return {
            title: "",
            metadata: {
              ...(typeof result.metadata === "object" && result.metadata !== null ? result.metadata : {}),
              mcpServer: clientName,
              mcpTool: mcpTool.name,
              truncated: false,
            },
            output: textParts.join("\n\n"),
            attachments,
          }
        }),
    },
    identity,
  )
}

function defs(key: string, client: MCPClient, timeouts: McpTimeouts) {
  return listTools(key, client, timeouts).pipe(
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client, options: ReturnType<typeof mcpRequestOptions>) => Promise<T[]>,
  label: string,
  timeouts: McpTimeouts,
) {
  return Effect.tryPromise({
    try: (signal) => withMcpRequest((requestSignal) => listFn(client, mcpRequestOptions(timeouts, requestSignal)), timeouts, `MCP ${label} ${clientName}`),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  manager: MCPServerManager<unknown>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, AITool>>
  readonly toolDefs: () => Effect.Effect<JYYTool.Def[]>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service
    const cfgSvc = yield* Config.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    const timeoutsFor = (mcp: ConfigMCP.Info | undefined): Effect.Effect<McpTimeouts> =>
      Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return resolveMcpTimeouts(mcp, {
          idleMs: cfg.experimental?.mcp_idle_timeout_ms ?? cfg.experimental?.mcp_timeout,
          totalMs: cfg.experimental?.mcp_total_timeout_ms,
        })
      })

    const closeTransport = (transport: Transport, context: Record<string, unknown>) =>
      Effect.tryPromise(() => withTimeout(transport.close(), MCP_CLOSE_GRACE_MS, "MCP transport close timed out")).pipe(
        Effect.catch((error) => {
          log.error("MCP transport close failed", {
            ...context,
            code: "MCP_TRANSPORT_CLOSE_FAILED",
            degraded: true,
            error: error instanceof Error ? error.message : String(error),
          })
          return Effect.void
        }),
      )

    const closeClientResource = (client: MCPClient, context: Record<string, unknown>) =>
      Effect.tryPromise(() => withTimeout(client.close(), MCP_CLOSE_GRACE_MS, "MCP client close timed out")).pipe(
        Effect.catch((error) => {
          log.error("MCP client close failed", {
            ...context,
            code: "MCP_TRANSPORT_CLOSE_FAILED",
            degraded: true,
            error: error instanceof Error ? error.message : String(error),
          })
          return Effect.void
        }),
      )

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeouts: McpTimeouts, key: string) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "jyycode", version: InstallationVersion })
              const connectTimeouts = {
                idleMs: timeouts.idleMs,
                totalMs: Math.min(timeouts.totalMs, timeouts.idleMs),
              }
              return withMcpRequest(() => client.connect(t), connectTimeouts, `MCP ${key} connect`).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) =>
          Exit.isFailure(exit) ? closeTransport(t, { key, operation: "connect" }) : Effect.void,
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(key, mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const timeouts = resolveMcpDiscoveryTimeouts(yield* timeoutsFor(mcp))
      const deadlineAt = Date.now() + timeouts.totalMs
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, remainingMcpTimeouts(timeouts, deadlineAt), key).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: jyycode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "jyycode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      const stderrPolicy = createStderrPolicy({ server: key })
      transport.stderr?.on("data", (chunk: Buffer) => {
        const report = stderrPolicy.push(chunk)
        log.debug("mcp stderr", report)
      })

      const timeouts = resolveMcpDiscoveryTimeouts(yield* timeoutsFor(mcp))
      return yield* connectTransport(transport, timeouts, key).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const timeouts = resolveMcpDiscoveryTimeouts(yield* timeoutsFor(mcp))
      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, timeouts)
      if (!listed) {
        yield* closeTransport(mcpClient.transport as Transport, { key, operation: "listTools" })
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeouts: McpTimeouts) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeouts))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const config = cfg.mcp ?? {}
        const s: State = {
          status: {},
          clients: {},
          defs: {},
          manager: new MCPServerManager({
            maxConcurrency: cfg.experimental?.mcp_max_concurrency,
            idleTtlMs: cfg.experimental?.mcp_idle_ttl_ms,
          }),
        }

        for (const [key, mcp] of Object.entries(config)) {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            continue
          }
          if (mcp.enabled === false) s.status[key] = { status: "disabled" }
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* closeClientResource(client, { operation: "state-finalizer" })
                }),
              { concurrency: "unbounded" },
            )
            yield* Effect.promise(() => s.manager.closeAll()).pipe(Effect.asVoid)
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
      {
        onInvalidate: (value) => Effect.promise(() => value.manager.closeAll()).pipe(Effect.asVoid),
      },
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return closeClientResource(client, { name, operation: "close" })
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeouts: McpTimeouts,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeouts)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => s.manager.acquirePermit()),
        () =>
          Effect.gen(function* () {
            const result = yield* create(name, mcp)

            s.status[name] = result.status
            if (!result.mcpClient) {
              yield* closeClient(s, name)
              delete s.clients[name]
              return result.status
            }

            const timeouts = yield* timeoutsFor(mcp)
            return yield* storeClient(s, name, result.mcpClient, result.defs!, timeouts)
          }),
        (permit) => Effect.sync(permit.release),
      )
    })

    const ensureConfigured = Effect.fn("MCP.ensureConfigured")(function* () {
      const s = yield* InstanceState.get(state)
      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      yield* Effect.forEach(
        Object.entries(config),
        ([key, mcp]) =>
          Effect.gen(function* () {
            if (!isMcpConfigured(mcp) || mcp.enabled === false || s.clients[key] || s.status[key]?.status === "disabled") return
            yield* createAndStore(key, mcp).pipe(Effect.catch(() => Effect.void))
          }),
        { concurrency: s.manager.maxConcurrency },
      )
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      yield* ensureConfigured()
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      const batches = yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const result: Array<{ identity: ToolIdentity; tool: AITool }> = []
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return []
            }

            const timeouts = yield* timeoutsFor(entry)
            for (const mcpTool of listed) {
              try {
                result.push({
                  identity: {
                    source: "mcp",
                    sourceID: `mcp:${clientName}\0${mcpTool.name}`,
                    modelName: sanitize(clientName) + "_" + sanitize(mcpTool.name),
                  },
                  tool: convertMcpTool(mcpTool, client, timeouts),
                })
              } catch (error) {
                log.warn("MCP tool unavailable because its input schema is not safely transformable", {
                  clientName,
                  tool: mcpTool.name,
                  error,
                })
              }
            }
            return result
          }),
        { concurrency: "unbounded" },
      )
      const entries = batches.flat()
      const resolved = resolveToolModelNames(entries.map((entry) => entry.identity))
      for (const collision of resolved.collisions) {
        log.warn("MCP tool model-name collision resolved", collision)
      }
      const result: Record<string, AITool> = {}
      for (const entry of entries) {
        const name = resolved.names.get(entry.identity.sourceID)
        if (!name) continue
        result[name] = entry.tool
      }
      return result
    })

    const toolDefs = Effect.fn("MCP.toolDefs")(function* () {
      yield* ensureConfigured()
      const result: IdentifiedToolDef[] = []
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeouts = yield* timeoutsFor(entry)
            for (const mcpTool of listed) {
              try {
                result.push(convertMcpToolDef(clientName, mcpTool, client, timeouts) as IdentifiedToolDef)
              } catch (error) {
                log.warn("MCP tool unavailable because its input schema is not safely transformable", {
                  clientName,
                  tool: mcpTool.name,
                  error,
                })
              }
            }
          }),
        { concurrency: "unbounded" },
      )
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, options: ReturnType<typeof mcpRequestOptions>) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          Effect.gen(function* () {
            const cfg = yield* cfgSvc.get()
            const entry = cfg.mcp?.[clientName]
            const timeouts = yield* timeoutsFor(isMcpConfigured(entry) ? entry : undefined)
            return yield* fetchFromClient(clientName, client, listFn, label, timeouts).pipe(
              Effect.map((items) => Object.entries(items ?? {})),
            )
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      yield* ensureConfigured()
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c, options) => c.listPrompts(undefined, options).then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      yield* ensureConfigured()
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c, options) => c.listResources(undefined, options).then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, options: ReturnType<typeof mcpRequestOptions>) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      const entry = cfg.mcp?.[clientName]
      const timeouts = yield* timeoutsFor(isMcpConfigured(entry) ? entry : undefined)
      return yield* Effect.tryPromise({
        try: (signal) => withMcpRequest((requestSignal) => fn(client, mcpRequestOptions(timeouts, requestSignal)), timeouts, `MCP ${label} ${clientName}`),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client, options) => client.getPrompt({ name, arguments: args }, options), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client, options) => client.readResource({ uri: resourceUri }, options), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      const timeouts = yield* timeoutsFor(mcpConfig)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpName, mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "jyycode", version: InstallationVersion })
          return withMcpRequest(() => client.connect(transport), timeouts, `MCP ${mcpName} auth connect`)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => (client ? closeClientResource(client, { mcpName, operation: "auth-config" }) : Effect.void)),
        )

        const timeouts = yield* timeoutsFor(mcpConfig)
        const listed = client ? yield* defs(mcpName, client, timeouts) : undefined
        if (!client || !listed) {
          if (client) yield* closeClientResource(client, { mcpName, operation: "auth-tools" })
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, timeouts)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      toolDefs,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."
