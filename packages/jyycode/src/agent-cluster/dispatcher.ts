import type { Complexity, PlannedTask, TaskRole, TaskStatus } from "./schema"

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
  picture_searcher: "Image research specialist for finding relevant images, diagrams, and visual assets.",
  analyst: "Analysis specialist for data interpretation, tradeoff comparison, and insight synthesis.",
  writer: "Writing specialist for polished sections, concise summaries, and narrative assembly.",
  chart: "Chart specialist for chart data, visualization specs, and generated chart artifacts.",
  pdf: "Document production specialist for final Markdown, DOCX, PDF, and export-ready artifacts.",
  coder: "Coding specialist for implementation, refactoring, and code changes.",
  tester: "Testing specialist for verification, regression checks, and test evidence.",
  general: "General specialist for tasks that do not fit a narrower cluster role.",
} satisfies Record<TaskRole, string>

const RETURN_FORMAT = [
  "",
  "## Return format",
  "",
  "Your final assistant message must start with:",
  "**Status**: success | partial | failed | blocked",
  "**Summary**: one sentence describing the result",
  "",
  "Then include the deliverable.",
  "If applicable, include:",
  "**Files touched**: comma-separated paths or (none)",
  "**Findings worth promoting**: bullet list or (none)",
].join("\n")

export function subagentPrompt(role: TaskRole) {
  return [
    SubagentDescriptions[role],
    "",
    "You are working inside a Multi-Agent cluster. Complete only the delegated task.",
    "Follow the acceptance criteria exactly, write requested artifacts to the specified paths, and return a concise report containing status, artifact paths, key findings, and any blockers.",
    "Do not claim completion for artifacts you did not create or verify.",
    RETURN_FORMAT,
  ].join("\n")
}

function listOrNone(items: readonly string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)"
}

export function buildTaskBrief(input: {
  goal: string
  task: PlannedTask
  peers: PlannedTask[]
  predecessors: Array<PlannedTask & { resultSummary?: string | null; status: TaskStatus }>
  consumers: PlannedTask[]
  reviewIssues: string[]
}): string {
  const acceptedPredecessors = input.predecessors.filter((task) => task.status === "accepted")
  return [
    "<cluster-task-brief>",
    `最终目标: ${input.goal}`,
    "",
    "当前任务:",
    `- step: ${input.task.step}`,
    `- task_id: ${input.task.id}`,
    `- title: ${input.task.title}`,
    `- 唯一职责: ${input.task.prompt}`,
    "- 禁止越界: 只完成本任务职责，不重复同一步协作者的工作，不提前完成后续任务。",
    "",
    "前序已完成:",
    acceptedPredecessors.length
      ? acceptedPredecessors
          .map((task) =>
            [
              `- ${task.id}: ${task.resultSummary?.trim() || "(no summary recorded)"}`,
              task.expectedArtifacts.length ? `  artifacts: ${task.expectedArtifacts.join(", ")}` : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n")
      : "- (none)",
    "",
    "后续交接:",
    input.consumers.length
      ? input.consumers
          .map((task) => `- ${task.id} — 需要你提供: ${input.task.expectedArtifacts.join(", ") || "清晰结果摘要"}`)
          .join("\n")
      : "- (none)",
    "",
    "同一步协作者:",
    input.peers.length
      ? input.peers.map((task) => `- ${task.id} — ${task.prompt}`).join("\n")
      : "- (none)",
    "",
    "验收标准:",
    listOrNone(input.task.acceptanceCriteria),
    "",
    "预期产物:",
    listOrNone(input.task.expectedArtifacts),
    "",
    "尚未解决的审核问题:",
    listOrNone(input.reviewIssues),
    "</cluster-task-brief>",
  ].join("\n")
}
