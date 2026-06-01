import type { Complexity, TaskRole } from "./schema"

export function modelForComplexity(input: {
  complexity: Complexity
  simpleModel: string
  complexModel: string
  visualModel?: string
  role?: TaskRole
}) {
  if (input.visualModel && (input.role === "chart" || input.role === "pdf")) return input.visualModel
  return input.complexity === "simple" ? input.simpleModel : input.complexModel
}

export const SubagentDescriptions = {
  researcher: "Research specialist for source collection, citation extraction, and evidence notes.",
  analyst: "Analysis specialist for data interpretation, tradeoff comparison, and insight synthesis.",
  writer: "Writing specialist for polished sections, concise summaries, and narrative assembly.",
  chart: "Chart specialist for chart data, visualization specs, and generated chart artifacts.",
  pdf: "Document production specialist for final Markdown, DOCX, PDF, and export-ready artifacts.",
  coder: "Coding specialist for implementation, refactoring, and code changes.",
  tester: "Testing specialist for verification, regression checks, and test evidence.",
  reviewer: "Sub-review specialist for independent critique. The cluster primary still makes final decisions.",
  general: "General specialist for tasks that do not fit a narrower cluster role.",
} satisfies Record<TaskRole, string>

export function subagentPrompt(role: TaskRole) {
  return [
    SubagentDescriptions[role],
    "",
    "You are working inside a Multi-Agent cluster. Complete only the delegated task.",
    "Follow the acceptance criteria exactly, write requested artifacts to the specified paths, and return a concise report containing status, artifact paths, key findings, and any blockers.",
    "Do not claim completion for artifacts you did not create or verify.",
  ].join("\n")
}
