import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { LsTool } from "./ls"
import { MultiEditTool } from "./multi-edit"
import { KillProcessTool, ProcessOutputTool, ProcessStartTool } from "./process"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TaskStatusTool } from "./task_status"
import { AgentClusterReviewTool } from "./agent-cluster-review"
import { ArtifactGetTool, ContextGetTool, ContextSearchTool } from "./workflow-context"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { SendMessageTool } from "./send-message"
import { SendFileTool } from "./send-file"
import { MemoryTool } from "./memory"
import * as Tool from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@jyycode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { RepoCloneTool } from "./repo_clone"
import { RepoOverviewTool } from "./repo_overview"
import { RepositoryCache } from "@/reference/repository-cache"
import * as Log from "@jyycode-ai/core/util/log"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@jyycode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Git } from "@/git"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Reference } from "@/reference/reference"
import { BackgroundJob } from "@/background/job"
import { BackgroundProcess } from "@/process/job"
import { SessionStatus } from "@/session/status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Memory } from "@/memory/memory"
import { CatalogSearch } from "./catalog-search"
import { ToolTelemetry } from "./telemetry"

const log = Log.create({ service: "tool.registry" })

export function webSearchEnabled(_providerID: ProviderID, _flags = { exa: false, parallel: false }) {
  return true
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type TaskStatusDef = Tool.InferDef<typeof TaskStatusTool>
type AgentClusterReviewDef = Tool.InferDef<typeof AgentClusterReviewTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  taskStatus: TaskStatusDef
  agentClusterReview: AgentClusterReviewDef
  read: ReadDef
}

const ToolSearchParameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search terms for finding relevant available tools" }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of tool matches to return (default: 8)",
  }),
  detail: Schema.optional(Schema.Literals(["summary", "schema", "full"])).annotate({
    description: "How much information to return for each match (default: summary)",
  }),
  category: Schema.optional(
    Schema.Literals([
      "filesystem",
      "code-search",
      "execution",
      "web",
      "mcp",
      "subagent",
      "communication",
      "memory",
      "other",
    ]),
  ).annotate({
    description: "Optional catalog category filter. Disclosure states such as 'hidden' are not categories.",
  }),
})

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderID
    modelID: ModelID
    agent: Agent.Info
    /** Persistent memory is only available to root sessions. */
    includeMemory?: boolean
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | SessionStatus.Service
  | BackgroundJob.Service
  | BackgroundProcess.Service
  | Provider.Service
  | Git.Service
  | RepositoryCache.Service
  | Reference.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const bus = yield* Bus.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const taskStatus = yield* TaskStatusTool
    const agentClusterReview = yield* AgentClusterReviewTool
    const contextSearch = yield* ContextSearchTool
    const contextGet = yield* ContextGetTool
    const artifactGet = yield* ArtifactGetTool
    const read = yield* ReadTool
    const ls = yield* LsTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const repoClone = yield* RepoCloneTool
    const repoOverview = yield* RepoOverviewTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const multiEdit = yield* MultiEditTool
    const processStart = yield* ProcessStartTool
    const processOutput = yield* ProcessOutputTool
    const killProcess = yield* KillProcessTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const sendMessage = yield* SendMessageTool
    const sendFile = yield* SendFileTool
    const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
    const memtool = memory ? yield* MemoryTool.pipe(Effect.provideService(Memory.Service, memory)) : undefined
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            catalog: {
              category: "other",
              mutability: "external",
              risk: "medium",
              detail: "advanced",
            },
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          ls: Tool.init(ls),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          multi_edit: Tool.init(multiEdit),
          process_start: Tool.init(processStart),
          process_output: Tool.init(processOutput),
          kill_process: Tool.init(killProcess),
          write: Tool.init(writetool),
          task: Tool.init(task),
          task_status: Tool.init(taskStatus),
          agent_cluster_review: Tool.init(agentClusterReview),
          context_search: Tool.init(contextSearch),
          context_get: Tool.init(contextGet),
          artifact_get: Tool.init(artifactGet),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          repo_clone: Tool.init(repoClone),
          repo_overview: Tool.init(repoOverview),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          send_message: Tool.init(sendMessage),
          send_file: Tool.init(sendFile),
          memory: memtool ? Tool.init(memtool) : Effect.succeed(undefined),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.ls,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.multi_edit,
            tool.process_start,
            tool.process_output,
            tool.kill_process,
            tool.write,
            tool.task,
            ...(flags.experimentalBackgroundSubagents ? [tool.task_status] : []),
            tool.agent_cluster_review,
            tool.context_search,
            tool.context_get,
            tool.artifact_get,
            tool.fetch,
            tool.todo,
            tool.search,
            ...(flags.experimentalScout ? [tool.repo_clone, tool.repo_overview] : []),
            tool.skill,
            tool.patch,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
            ...(tool.memory ? [tool.memory] : []),
            tool.send_message,
            tool.send_file,
          ],
          task: tool.task,
          taskStatus: tool.task_status,
          agentClusterReview: tool.agent_cluster_review,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const list = yield* allowedTaskAgents(agent)
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const allowedTaskAgents = Effect.fn("ToolRegistry.allowedTaskAgents")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary" && item.hidden !== true)
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      return filtered.toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const s = yield* InstanceState.get(state)
      const available = [
        ...s.builtin.filter((tool) => input.includeMemory !== false || tool.id !== MemoryTool.id),
        ...(input.agent.name === "cluster" && !s.builtin.some((tool) => tool.id === TaskStatusTool.id)
          ? [s.taskStatus]
          : []),
        ...(input.agent.name === "cluster" && !s.builtin.some((tool) => tool.id === AgentClusterReviewTool.id)
          ? [s.agentClusterReview]
          : []),
        ...s.custom,
      ]
      const filtered = available.filter((tool) => {
        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const resolved = yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          const clusterTask = tool.id === TaskTool.id && input.agent.name === "cluster"
          const taskAgents = tool.id === TaskTool.id ? yield* allowedTaskAgents(input.agent) : undefined
          const taskJsonSchema = taskAgents
            ? withTaskAgentEnum(
                clusterTask
                  ? ToolJsonSchema.fromSchema(output.parameters as Schema.Top)
                  : (output.jsonSchema ?? ToolJsonSchema.fromSchema(output.parameters as Schema.Top)),
                taskAgents,
              )
            : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              clusterTask
                ? "Cluster mode: task calls run as background subagents by default. Dispatch all ready independent tasks first, then use task_status to poll or wait for results."
                : undefined,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            catalog: tool.catalog,
            jsonSchema: taskJsonSchema ?? (clusterTask ? undefined : jsonSchema),
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
      return [toolSearchDef(resolved, bus), ...resolved]
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer
    .pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(
        Layer.mergeAll(SessionStatus.defaultLayer, BackgroundJob.defaultLayer, BackgroundProcess.defaultLayer),
      ),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Layer.mergeAll(Truncate.defaultLayer, Memory.defaultLayer)),
    )
    .pipe(Layer.provide(RuntimeFlags.defaultLayer)),
)

function toolSearchDef(tools: Tool.Def[], bus: Bus.Interface): Tool.Def<typeof ToolSearchParameters> {
  return {
    id: "tool_search",
    description:
      "Search the currently available tool catalog by ranked metadata and keyword matches. Use this when you are unsure which tool is best for a task.",
    parameters: ToolSearchParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const detail = params.detail ?? "summary"
        const scored = CatalogSearch.search({
          tools,
          query: params.query,
          limit: params.limit,
          detail,
          category: params.category,
        })
        const output = CatalogSearch.formatResults(scored, { detail })
        const resultIDs = scored.map((item) => item.tool.id)
        yield* ToolTelemetry.searchExecuted(bus, {
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          query: params.query,
          detail,
          category: params.category,
          resultIDs,
        })

        return {
          title: `Tool search: ${params.query}`,
          metadata: {
            matches: scored.length,
            resultIDs,
            detail,
            truncated: false,
          },
          output,
        }
      }),
  }
}

function withTaskAgentEnum(schema: JSONSchema7, agents: Agent.Info[]): JSONSchema7 {
  const cloned = JSON.parse(JSON.stringify(schema)) as JSONSchema7
  if (typeof cloned === "boolean") return cloned
  const properties = cloned.properties
  if (!properties || typeof properties !== "object") return cloned
  const subagent = properties.subagent_type
  if (!subagent || typeof subagent === "boolean") return cloned
  const enumValues = agents.map((item) => item.name)
  properties.subagent_type = {
    ...subagent,
    enum: enumValues,
    description: [
      typeof subagent.description === "string" ? subagent.description : "The type of specialized agent to use",
      "",
      "Allowed values:",
      ...agents.map(
        (item) => `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
      ),
    ].join("\n"),
  }
  return cloned
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ToolRegistry from "./registry"
