import { describe, expect, test } from "bun:test"
import { buildTaskBrief, modelForComplexity, SubagentDescriptions, subagentPrompt } from "../../src/agent-cluster/dispatcher"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"

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

  test("routes image-search tasks to the visual model", () => {
    expect(
      modelForComplexity({
        complexity: "simple",
        simpleModel: models.simpleModel,
        complexModel: models.complexModel,
        visualModel: "gemini/visual",
        role: "picture_searcher",
      }),
    ).toBe("gemini/visual")
  })
})

describe("SubagentDescriptions", () => {
  test("has description for all 9 roles", () => {
    const roles = ["researcher", "analyst", "writer", "chart", "pdf", "coder", "tester", "picture_searcher", "general"]
    for (const role of roles) {
      expect(SubagentDescriptions[role as keyof typeof SubagentDescriptions]).toBeTruthy()
    }
  })
})

describe("buildTaskBrief", () => {
  const task = (input: {
    id: string
    step: number
    prompt: string
    dependencies?: string[]
    expectedArtifacts?: string[]
  }) => ({
    id: AgentClusterRuntime.coerceTaskID(input.id),
    step: input.step,
    title: input.id,
    role: "coder" as const,
    complexity: "simple" as const,
    model: "provider/model",
    dependencies: (input.dependencies ?? []).map(AgentClusterRuntime.coerceTaskID),
    prompt: input.prompt,
    acceptanceCriteria: ["tests pass"],
    expectedArtifacts: input.expectedArtifacts ?? [],
  })

  test("includes goal, predecessor handoff, peers, consumers, and acceptance criteria", () => {
    const research = task({ id: "research", step: 1, prompt: "只负责调研", expectedArtifacts: ["notes.md"] })
    const api = task({
      id: "api",
      step: 2,
      prompt: "只负责 API",
      dependencies: ["research"],
      expectedArtifacts: ["api.patch"],
    })
    const ui = task({ id: "ui", step: 2, prompt: "只负责界面" })
    const test = task({ id: "test", step: 3, prompt: "只负责测试", dependencies: ["api"] })

    const brief = buildTaskBrief({
      goal: "ship feature",
      task: api,
      peers: [ui],
      predecessors: [{ ...research, status: "accepted", resultSummary: "调研完成" }],
      consumers: [test],
      reviewIssues: ["补充错误处理"],
    })

    expect(brief).toContain("最终目标: ship feature")
    expect(brief).toContain("前序已完成:")
    expect(brief).toContain("research: 调研完成")
    expect(brief).toContain("同一步协作者:")
    expect(brief).toContain("ui — 只负责界面")
    expect(brief).toContain("后续交接:")
    expect(brief).toContain("test")
    expect(brief).toContain("tests pass")
    expect(brief).toContain("补充错误处理")
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
