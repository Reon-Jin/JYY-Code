import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("JYYCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: bool(name) }).pipe(Config.map((flags) => flags.experimental || flags.enabled))

export class Service extends ConfigService.Service<Service>()("@jyycode/RuntimeFlags", {
  autoShare: bool("JYYCODE_AUTO_SHARE"),
  pure: bool("JYYCODE_PURE"),
  disableDefaultPlugins: bool("JYYCODE_DISABLE_DEFAULT_PLUGINS"),
  disableChannelDb: bool("JYYCODE_DISABLE_CHANNEL_DB"),
  disableEmbeddedWebUi: bool("JYYCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("JYYCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("JYYCODE_DISABLE_LSP_DOWNLOAD"),
  skipMigrations: bool("JYYCODE_SKIP_MIGRATIONS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("JYYCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("JYYCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("JYYCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("JYYCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("JYYCODE_ENABLE_EXA"),
    legacy: bool("JYYCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("JYYCODE_ENABLE_PARALLEL"),
    legacy: bool("JYYCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("JYYCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("JYYCODE_ENABLE_QUESTION_TOOL"),
  experimentalScout: enabledByExperimental("JYYCODE_EXPERIMENTAL_SCOUT"),
  experimentalBackgroundSubagents: enabledByExperimental("JYYCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("JYYCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("JYYCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("JYYCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("JYYCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("JYYCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("JYYCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("JYYCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  experimentalDeferredTools: enabledByExperimental("JYYCODE_EXPERIMENTAL_DEFERRED_TOOLS"),
  deferredToolThreshold: positiveInteger("JYYCODE_DEFERRED_TOOL_THRESHOLD"),
  outputTokenMax: positiveInteger("JYYCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("JYYCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: enabledByExperimental("JYYCODE_EXPERIMENTAL_NATIVE_LLM"),
  client: Config.string("JYYCODE_CLIENT").pipe(Config.withDefault("cli")),
  // --- New feature flags ---
  skillSearch: enabledByExperimental("JYYCODE_SKILL_SEARCH"),
  toolSearch: enabledByExperimental("JYYCODE_TOOL_SEARCH"),
  skillLearning: enabledByExperimental("JYYCODE_SKILL_LEARNING"),
  proactiveMode: enabledByExperimental("JYYCODE_PROACTIVE_MODE"),
  microCompact: enabledByExperimental("JYYCODE_MICRO_COMPACT"),
  reactiveCompact: enabledByExperimental("JYYCODE_REACTIVE_COMPACT"),
  costTracking: enabledByExperimental("JYYCODE_COST_TRACKING"),
  daemonMode: enabledByExperimental("JYYCODE_DAEMON_MODE"),
  langfuse: enabledByExperimental("JYYCODE_LANGFUSE"),
  buildOptimization: enabledByExperimental("JYYCODE_BUILD_OPTIMIZATION"),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
