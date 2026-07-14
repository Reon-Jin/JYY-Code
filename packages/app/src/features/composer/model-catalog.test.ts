import type { Agent, AgentClusterConfig, Config, Path, Provider } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import {
  loadComposerPreference,
  loadModelCatalog,
  saveComposerPreference,
  type ComposerPreference,
} from "./model-catalog"

const directory = "C:\\work\\demo"

function agent(name: string, mode: Agent["mode"] = "primary", model?: Agent["model"]): Agent {
  return { name, mode, model, permission: [], options: {} }
}

function provider(id: string, modelIDs: string[]): Provider {
  return {
    id,
    name: id.toUpperCase(),
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(
      modelIDs.map((modelID) => [
        modelID,
        {
          id: modelID,
          providerID: id,
          api: { id: modelID, url: "https://example.test", npm: "test" },
          name: modelID.toUpperCase(),
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 100_000, output: 10_000 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        },
      ]),
    ),
  }
}

function response<T>(data: T) {
  return Promise.resolve({ data })
}

function createClient(input?: {
  agents?: Agent[]
  providers?: Provider[]
  configuredProviders?: Provider[]
  connected?: string[]
  defaults?: Record<string, string>
  config?: Config
  agentCluster?: AgentClusterConfig
  path?: Path
}) {
  const providers = input?.providers ?? [provider("openai", ["gpt-4.1", "gpt-5"])]
  const configuredProviders = input?.configuredProviders ?? providers
  return {
    app: { agents: vi.fn(() => response(input?.agents ?? [agent("plan"), agent("build")])) },
    config: {
      providers: vi.fn(() =>
        response({ providers: configuredProviders, default: input?.defaults ?? { openai: "gpt-5" } }),
      ),
      get: vi.fn(() => response(input?.config ?? ({ default_agent: "plan", model: "openai/gpt-5" } as Config))),
    },
    provider: {
      list: vi.fn(() =>
        response({
          all: providers,
          default: input?.defaults ?? { openai: "gpt-5" },
          connected: input?.connected ?? ["openai"],
        }),
      ),
    },
    path: {
      get: vi.fn(() =>
        response(input?.path ?? { home: "C:\\Users\\dev", state: "state", config: "C:\\Users\\dev\\.config\\jyycode" }),
      ),
    },
    global: {
      config: {
        get: vi.fn(() => response({ agent_cluster: input?.agentCluster ?? { enabled: true, default_on: false } })),
      },
    },
  }
}

describe("loadModelCatalog", () => {
  it("loads all catalog inputs in parallel and chooses configured defaults", async () => {
    const client = createClient()
    const promise = loadModelCatalog({ client: client as never, directory })

    expect(client.app.agents).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.config.providers).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.provider.list).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.config.get).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.path.get).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.global.config.get).toHaveBeenCalledWith({ throwOnError: true })

    const catalog = await promise
    expect(catalog.selectedAgent).toBe("plan")
    expect(catalog.selectedModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(catalog.configPath).toBe("C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc")
    expect(catalog.agentCluster.default_on).toBe(false)
  })

  it("keeps subagents available for child identity without exposing them to root selection", async () => {
    const catalog = await loadModelCatalog({
      client: createClient({ agents: [agent("build"), agent("coder", "subagent")] }) as never,
      directory,
    })

    expect(catalog.agents.map((candidate) => candidate.name)).not.toContain("coder")
    expect(catalog.allAgents.map((candidate) => candidate.name)).toContain("coder")
  })

  it("revalidates stored IDs and ignores disconnected providers", async () => {
    const providers = [provider("openai", ["gpt-5"]), provider("anthropic", ["claude-sonnet"])]
    const preference: ComposerPreference = {
      agent: "removed-agent",
      model: { providerID: "openai", modelID: "removed-model" },
    }
    const client = createClient({
      agents: [agent("build")],
      providers,
      configuredProviders: [providers[1]!],
      connected: ["anthropic"],
      defaults: { anthropic: "claude-sonnet" },
      config: { default_agent: "removed-agent", model: "openai/gpt-5" } as Config,
    })

    const catalog = await loadModelCatalog({ client: client as never, directory, preference })

    expect(catalog.selectedAgent).toBe("build")
    expect(catalog.selectedModel).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" })
    expect(catalog.models.map((model) => model.providerID)).toEqual(["anthropic"])
  })

  it("does not silently select a model when no provider is connected", async () => {
    const catalog = await loadModelCatalog({
      client: createClient({ configuredProviders: [], connected: [] }) as never,
      directory,
    })
    expect(catalog.models).toEqual([])
    expect(catalog.selectedModel).toBeUndefined()
  })

  it("prefers the global planner model over a stale local preference", async () => {
    const catalog = await loadModelCatalog({
      client: createClient({
        agentCluster: { enabled: true, planner_model: "openai/gpt-4.1" },
      }) as never,
      directory,
      preference: { model: { providerID: "openai", modelID: "gpt-5" } },
    })

    expect(catalog.selectedModel).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
  })

  it("accepts a unique bare global planner ID and excludes deprecated models", async () => {
    const openai = provider("openai", ["planner", "legacy"])
    openai.models.legacy!.status = "deprecated"
    const catalog = await loadModelCatalog({
      client: createClient({
        providers: [openai],
        configuredProviders: [openai],
        defaults: { openai: "planner" },
        agentCluster: { planner_model: "planner" },
      }) as never,
      directory,
    })

    expect(catalog.selectedModel).toEqual({ providerID: "openai", modelID: "planner" })
    expect(catalog.models.map((model) => model.modelID)).toEqual(["planner"])
  })

  it("ignores environment-discovered providers that are absent from config.providers", async () => {
    const deepseek = provider("deepseek", ["deepseek-v4-flash"])
    const anthropic = provider("anthropic", ["claude-opus-4-8", "claude-sonnet-5"])
    const catalog = await loadModelCatalog({
      client: createClient({
        providers: [anthropic, deepseek],
        configuredProviders: [deepseek],
        connected: ["anthropic", "deepseek"],
        defaults: { deepseek: "deepseek-v4-flash" },
      }) as never,
      directory,
    })

    expect(catalog.models.map((model) => model.providerID)).toEqual(["deepseek"])
  })

  it("persists only Agent and model identifiers", () => {
    const values = new Map<string, string>()
    const storage: Pick<Storage, "getItem" | "setItem"> = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) {
        values.set(key, value)
      },
    }
    saveComposerPreference({ agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, storage)
    expect(loadComposerPreference(storage)).toEqual({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
    })
    expect([...values.values()][0]).toBe(
      JSON.stringify({ agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }),
    )
  })
})
