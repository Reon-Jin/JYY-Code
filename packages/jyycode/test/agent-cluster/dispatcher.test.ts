import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  buildTaskBrief,
  modelForComplexity,
  SubagentDescriptions,
  subagentPrompt,
} from "../../src/agent-cluster/dispatcher"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import {
  allRoleSkillModules,
  primarySkillPermission,
  RoleSkillDefinitions,
  roleSkillName,
  roleSkillNames,
  roleSkillPermission,
  roleSystemPrompt,
} from "../../src/agent-cluster/role-skills"
import { Permission } from "../../src/permission"

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

  test("routes office tasks to the visual model", () => {
    expect(
      modelForComplexity({
        complexity: "simple",
        simpleModel: models.simpleModel,
        complexModel: models.complexModel,
        visualModel: "gemini/visual",
        role: "office",
      }),
    ).toBe("gemini/visual")
  })
})

describe("SubagentDescriptions", () => {
  test("vendors companion resources for active upstream workflows", () => {
    const root = path.resolve(import.meta.dir, "../../src/agent-cluster/role-skills/upstream")
    const required = [
      "k-dense/literature-review/assets/review_template.md",
      "k-dense/literature-review/scripts/verify_citations.py",
      "k-dense/research-lookup/scripts/research_lookup.py",
      "k-dense/peer-review/references/common_issues.md",
      "k-dense/statistical-analysis/scripts/assumption_checks.py",
      "k-dense/scientific-writing/assets/scientific_report_template.tex",
      "k-dense/scientific-visualization/assets/publication.mplstyle",
      "k-dense/scientific-slides/scripts/pdf_to_images.py",
      "k-dense/seaborn/references/examples.md",
      "github/acquire-codebase-knowledge/scripts/scan.py",
      "github/acquire-codebase-knowledge/assets/templates/ARCHITECTURE.md",
    ]
    for (const resource of required) {
      expect(existsSync(path.join(root, resource))).toBe(true)
    }
  })

  test("has description for all 8 cluster roles", () => {
    const roles = ["researcher", "analyst", "writer", "chart", "office", "coder", "tester", "general"]
    for (const role of roles) {
      expect(SubagentDescriptions[role as keyof typeof SubagentDescriptions]).toBeTruthy()
    }
    expect(SubagentDescriptions).not.toHaveProperty("picture_searcher")
  })

  test("has one isolated built-in skill for every role", () => {
    const roles = Object.keys(RoleSkillDefinitions)
    expect(new Set(roles.map((role) => roleSkillName(role))).size).toBe(roles.length)
    for (const role of roles) {
      expect(RoleSkillDefinitions[role as keyof typeof RoleSkillDefinitions].skillContent).toContain("---")
      expect(RoleSkillDefinitions[role as keyof typeof RoleSkillDefinitions].capabilitySummary).toBeTruthy()
    }
  })

  test("gives every local role profile a cross-platform runtime contract", () => {
    for (const role of Object.keys(RoleSkillDefinitions)) {
      const profile = RoleSkillDefinitions[role as keyof typeof RoleSkillDefinitions]
      expect(profile.skillContent).toContain("## Platform compatibility")
      expect(profile.skillContent).toContain("Windows")
      expect(profile.skillContent).toContain("macOS")
      expect(profile.skillContent).toContain("Linux")
    }
  })

  test("gives every active upstream workflow a cross-platform runtime contract", () => {
    for (const module of allRoleSkillModules()) {
      expect(module.content).toContain("## Platform compatibility")
      expect(module.content).toContain("Windows")
      expect(module.content).toContain("macOS")
      expect(module.content).toContain("Linux")
    }
  })

  test("keeps only compatible specialist workflows in each role catalog", () => {
    expect(roleSkillNames("researcher")).toContain("literature-review")
    expect(roleSystemPrompt("researcher")).toContain("Visual-asset research")
    expect(roleSkillNames("analyst")).toEqual(["cluster-analysis-insights", "statistical-analysis"])
    expect(roleSkillNames("coder")).toContain("security-and-hardening")
    expect(roleSkillNames("tester")).toContain("debugging-and-error-recovery")
    expect(roleSkillNames("tester")).not.toContain("test-driven-development")
    expect(roleSkillNames("chart")).toContain("scientific-visualization")
    expect(roleSkillNames("chart")).not.toContain("infographics")
    expect(roleSkillNames("office")).toEqual(["cluster-office-production", "pdf"])
    expect(roleSystemPrompt("office")).toContain("DOCX")
    expect(roleSystemPrompt("office")).toContain("XLSX")
    expect(roleSystemPrompt("office")).toContain("PPTX")
    expect(RoleSkillDefinitions).not.toHaveProperty("pdf")
    expect(roleSkillNames("explore")).toContain("acquire-codebase-knowledge")
    expect(roleSkillNames("explore")).not.toContain("what-context-needed")
    expect(roleSkillNames("scout")).toContain("source-driven-development")
    expect(roleSkillNames("scout")).not.toContain("web-search")
    expect(roleSkillNames("general")).toEqual(["cluster-general-handoff"])
    expect(RoleSkillDefinitions).not.toHaveProperty("picture_searcher")
    expect(roleSkillNames("coder")).not.toContain("literature-review")
  })
})

describe("skill visibility", () => {
  test("allows the primary only its built-in customization skill and global user skills", () => {
    const rules = Permission.fromConfig({ skill: primarySkillPermission(["my-global-skill"]) })
    expect(Permission.evaluate("skill", "customize-jyycode", rules).action).toBe("allow")
    expect(Permission.evaluate("skill", "my-global-skill", rules).action).toBe("allow")
    expect(Permission.evaluate("skill", "cluster-safe-implementation", rules).action).toBe("deny")
    expect(Permission.evaluate("skill", "project-skill", rules).action).toBe("deny")
  })

  test("allows each child role only its assigned skill catalog", () => {
    const rules = Permission.fromConfig({ skill: roleSkillPermission("coder") })
    expect(Permission.evaluate("skill", "cluster-safe-implementation", rules).action).toBe("allow")
    expect(Permission.evaluate("skill", "literature-review", rules).action).toBe("deny")
  })

  test("does not expose inactive or obsolete workflows to researcher", () => {
    const rules = Permission.fromConfig({ skill: roleSkillPermission("researcher") })
    expect(Permission.evaluate("skill", "cluster-research-evidence", rules).action).toBe("allow")
    expect(Permission.evaluate("skill", "images-search", rules).action).toBe("deny")
    expect(Permission.evaluate("skill", "web-search", rules).action).toBe("deny")
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
    expect(prompt).toContain('role="researcher"')
    expect(prompt).toContain("cluster-research-evidence")
    expect(prompt).toContain("literature-review")
    expect(prompt).toContain("Visual-asset research")
    expect(prompt).toContain("Multi-Agent cluster")
    expect(prompt).toContain("acceptance criteria")
  })

  test("returns multi-line prompt for coder role", () => {
    const prompt = subagentPrompt("coder")
    expect(prompt).toContain('role="coder"')
    expect(prompt).toContain("cluster-safe-implementation")
    expect(prompt).toContain("security-and-hardening")
    expect(prompt).toContain("Multi-Agent cluster")
  })

  test("does not cross-load another role's skill content", () => {
    const chart = roleSystemPrompt("chart")
    const coder = roleSystemPrompt("coder")
    expect(chart).toContain("cluster-chart-visualization")
    expect(chart).not.toContain("cluster-safe-implementation")
    expect(coder).toContain("cluster-safe-implementation")
    expect(coder).not.toContain("cluster-chart-visualization")
  })

  test("subagent prompt requires structured final status", () => {
    const prompt = subagentPrompt("coder")
    expect(prompt).toContain("**Status**: success | partial | failed | blocked")
    expect(prompt).toContain("**Summary**:")
    expect(prompt).toContain("Files touched")
  })
})
