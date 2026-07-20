export type MultiAgentRoleCapability = {
  skill: string
  skills: readonly string[]
  summary: string
}

export const multiAgentRoleCapabilities: Record<string, MultiAgentRoleCapability> = {
  researcher: {
    skill: "cluster-research-evidence",
    skills: ["cluster-research-evidence", "literature-review", "research-lookup", "peer-review"],
    summary: "sources · citations · evidence ledger",
  },
  analyst: {
    skill: "cluster-analysis-insights",
    skills: ["cluster-analysis-insights", "exploratory-data-analysis", "statistical-analysis"],
    summary: "data checks · comparisons · uncertainty",
  },
  writer: {
    skill: "cluster-clear-writing",
    skills: ["cluster-clear-writing", "scientific-writing", "documentation-and-adrs"],
    summary: "outline · clarity · audience fit",
  },
  coder: {
    skill: "cluster-safe-implementation",
    skills: [
      "cluster-safe-implementation",
      "incremental-implementation",
      "api-and-interface-design",
      "security-and-hardening",
      "code-review-and-quality",
    ],
    summary: "implementation · security review · verification",
  },
  tester: {
    skill: "cluster-regression-verification",
    skills: [
      "cluster-regression-verification",
      "test-driven-development",
      "debugging-and-error-recovery",
      "webapp-testing",
      "playwright-generate-test",
    ],
    summary: "test matrix · regression · evidence",
  },
  chart: {
    skill: "cluster-chart-visualization",
    skills: ["cluster-chart-visualization", "scientific-visualization", "infographics"],
    summary: "chart choice · declarative spec · accessibility",
  },
  pdf: {
    skill: "cluster-document-production",
    skills: ["cluster-document-production", "pdf"],
    summary: "semantic layout · export · render QA",
  },
  picture_searcher: {
    skill: "cluster-licensed-visual-search",
    skills: ["cluster-licensed-visual-search", "images-search", "web-search"],
    summary: "asset search · licensing · attribution",
  },
  general: {
    skill: "cluster-general-handoff",
    skills: ["cluster-general-handoff", "context-engineering", "doubt-driven-development"],
    summary: "scope · lightweight workflow · handoff",
  },
  explore: {
    skill: "cluster-codebase-exploration",
    skills: ["cluster-codebase-exploration", "acquire-codebase-knowledge", "repo-story-time", "what-context-needed"],
    summary: "file map · symbol search · call graph",
  },
  scout: {
    skill: "cluster-external-source-scout",
    skills: ["cluster-external-source-scout", "web-search", "llm-context", "answers", "source-driven-development"],
    summary: "official docs · versions · dependency source",
  },
}

const UNKNOWN_ROLE_CAPABILITY: MultiAgentRoleCapability = {
  skill: "role-skill-unassigned",
  skills: [],
  summary: "No specialist skill metadata",
}

export function roleCapability(role: string) {
  return multiAgentRoleCapabilities[role.toLowerCase()] ?? UNKNOWN_ROLE_CAPABILITY
}
