import { describe, expect, test } from "bun:test"
import { modelForComplexity, SubagentDescriptions, subagentPrompt } from "../../src/agent-cluster/dispatcher"

describe("modelForComplexity", () => {
  const models = {
    simpleModel: "deepseek-v4-flash",
    complexModel: "deepseek-v4-pro",
  }

  test("routes simple tasks to flash model", () => {
    expect(
      modelForComplexity({
        complexity: "simple",
        simpleModel: models.simpleModel,
        complexModel: models.complexModel,
      }),
    ).toBe("deepseek-v4-flash")
  })

  test("routes complex tasks to pro model", () => {
    expect(
      modelForComplexity({
        complexity: "complex",
        simpleModel: models.simpleModel,
        complexModel: models.complexModel,
      }),
    ).toBe("deepseek-v4-pro")
  })
})

describe("SubagentDescriptions", () => {
  test("has description for all 9 roles", () => {
    const roles = ["researcher", "analyst", "writer", "chart", "pdf", "coder", "tester", "reviewer", "general"]
    for (const role of roles) {
      expect(SubagentDescriptions[role as keyof typeof SubagentDescriptions]).toBeTruthy()
    }
  })
})

describe("subagentPrompt", () => {
  test("returns multi-line prompt for researcher role", () => {
    const prompt = subagentPrompt("researcher")
    expect(prompt).toContain("Research specialist")
    expect(prompt).toContain("Multi-Agent cluster")
    expect(prompt).toContain("acceptance criteria")
  })

  test("returns multi-line prompt for coder role", () => {
    const prompt = subagentPrompt("coder")
    expect(prompt).toContain("Coding specialist")
    expect(prompt).toContain("Multi-Agent cluster")
  })

  test("subagent prompt requires structured final status", () => {
    const prompt = subagentPrompt("coder")
    expect(prompt).toContain("**Status**: success | partial | failed | blocked")
    expect(prompt).toContain("**Summary**:")
    expect(prompt).toContain("Files touched")
  })
})
