import { describe, expect, test } from "bun:test"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"

describe("ConfigAgentCluster.Default", () => {
  test("enabled defaults to true", () => {
    expect(ConfigAgentCluster.Default.enabled).toBe(true)
  })

  test("default_on defaults to false", () => {
    expect(ConfigAgentCluster.Default.default_on).toBe(false)
  })

  test("disable_for_routes contains 'mail'", () => {
    expect(ConfigAgentCluster.Default.disable_for_routes).toContain("mail")
  })

  test("planner_model defaults to deepseek-v4-flash", () => {
    expect(ConfigAgentCluster.Default.planner_model).toBe("deepseek-v4-flash")
  })

  test("complex_model defaults to deepseek-v4-flash", () => {
    expect(ConfigAgentCluster.Default.complex_model).toBe("deepseek-v4-flash")
  })

  test("simple_model defaults to deepseek-v4-flash", () => {
    expect(ConfigAgentCluster.Default.simple_model).toBe("deepseek-v4-flash")
  })

  test("max_subagents defaults to 100", () => {
    expect(ConfigAgentCluster.Default.max_subagents).toBe(100)
  })

  test("max_concurrency defaults to 10", () => {
    expect(ConfigAgentCluster.Default.max_concurrency).toBe(10)
  })

  test("max_review_rounds defaults to 2", () => {
    expect(ConfigAgentCluster.Default.max_review_rounds).toBe(2)
  })

  test("artifact_dir defaults to .", () => {
    expect(ConfigAgentCluster.Default.artifact_dir).toBe(".")
  })
})

describe("ConfigAgentCluster.resolve", () => {
  test("ignores the deprecated reviewer model override", () => {
    expect(ConfigAgentCluster.resolve({ reviewer_model: "test/reviewer" })).not.toHaveProperty("reviewer_model")
  })

  test("returns defaults when input is undefined", () => {
    const result = ConfigAgentCluster.resolve(undefined)
    expect(result).toEqual(ConfigAgentCluster.Default)
  })

  test("returns defaults when input is empty", () => {
    const result = ConfigAgentCluster.resolve({})
    expect(result).toEqual(ConfigAgentCluster.Default)
  })

  test("overrides simple_model", () => {
    const result = ConfigAgentCluster.resolve({ simple_model: "claude-sonnet-4-6" })
    expect(result.simple_model).toBe("claude-sonnet-4-6")
    expect(result.complex_model).toBe(ConfigAgentCluster.Default.complex_model)
  })

  test("overrides complex_model", () => {
    const result = ConfigAgentCluster.resolve({ complex_model: "claude-opus-4-7" })
    expect(result.complex_model).toBe("claude-opus-4-7")
  })

  test("overrides max_subagents", () => {
    const result = ConfigAgentCluster.resolve({ max_subagents: 50 })
    expect(result.max_subagents).toBe(50)
  })

  test("overrides max_review_rounds", () => {
    const result = ConfigAgentCluster.resolve({ max_review_rounds: 3 })
    expect(result.max_review_rounds).toBe(3)
  })

  test("overrides multiple fields simultaneously", () => {
    const result = ConfigAgentCluster.resolve({
      enabled: false,
      simple_model: "gpt-4o-mini",
      max_subagents: 10,
    })
    expect(result.enabled).toBe(false)
    expect(result.simple_model).toBe("gpt-4o-mini")
    expect(result.max_subagents).toBe(10)
    expect(result.complex_model).toBe(ConfigAgentCluster.Default.complex_model)
  })

  test("disable_for_routes preserves default when not provided", () => {
    const result = ConfigAgentCluster.resolve({})
    expect(result.disable_for_routes).toEqual(["mail"])
  })

  test("disable_for_routes can be overridden", () => {
    const result = ConfigAgentCluster.resolve({ disable_for_routes: ["mail", "slack"] })
    expect(result.disable_for_routes).toEqual(["mail", "slack"])
  })
})
