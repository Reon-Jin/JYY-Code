import { normalizeDirectory } from "../platform/desktop-path"
export { normalizeDirectory } from "../platform/desktop-path"

const project = (directory: string) => ["project", normalizeDirectory(directory)] as const

export const keys = {
  management: ["management"] as const,
  managementSkills: ["management", "skills"] as const,
  managementSkill: (name: string) => ["management", "skills", name] as const,
  managementMcpConfig: ["management", "mcp", "config"] as const,
  managementMcpStatus: ["management", "mcp", "status"] as const,
  project,
  sessions: (directory: string, archived = false) =>
    archived
      ? ([...project(directory), "sessions", "archived"] as const)
      : ([...project(directory), "sessions"] as const),
  sessionsAll: (directory: string) => [...project(directory), "sessions", "all"] as const,
  session: (directory: string, sessionID: string) => [...project(directory), "session", sessionID] as const,
  messages: (directory: string, sessionID: string) =>
    [...project(directory), "session", sessionID, "messages"] as const,
  todos: (directory: string, sessionID: string) => [...project(directory), "session", sessionID, "todos"] as const,
  status: (directory: string) => [...project(directory), "status"] as const,
  permissions: (directory: string) => [...project(directory), "permissions"] as const,
  questions: (directory: string) => [...project(directory), "questions"] as const,
  vcsInfo: (directory: string) => [...project(directory), "vcs", "info"] as const,
  vcsBranches: (directory: string) => [...project(directory), "vcs", "branches"] as const,
  vcsDiff: (directory: string) => [...project(directory), "vcs", "diff"] as const,
  githubStatus: (directory: string) => [...project(directory), "github", "status"] as const,
  pullRequestsScope: (directory: string) => [...project(directory), "github", "pulls"] as const,
  pullRequests: (directory: string, state: "open" | "closed" | "merged" | "all") =>
    [...project(directory), "github", "pulls", state] as const,
  pullRequest: (directory: string, number: number) => [...project(directory), "github", "pull", number] as const,
  pullRequestDiff: (directory: string, number: number) =>
    [...project(directory), "github", "pull", number, "diff"] as const,
  agentClustersScope: (directory: string) => [...project(directory), "agent-clusters"] as const,
  agentCluster: (directory: string, sessionID: string) => [...project(directory), "agent-clusters", sessionID] as const,
  workflowScope: (directory: string) => [...project(directory), "workflow"] as const,
  workflowRunPlan: (directory: string, sessionID: string) =>
    [...project(directory), "workflow", "run-plan", sessionID] as const,
  workflowPlanVersions: (directory: string, sessionID: string) =>
    [...project(directory), "workflow", "run-plan-versions", sessionID] as const,
  workflowArtifacts: (directory: string, sessionID: string) =>
    [...project(directory), "workflow", "artifacts", sessionID] as const,
  workflowBlackboard: (directory: string, sessionID: string) => [...project(directory), "workflow", "blackboard", sessionID] as const,
  workflowReviews: (directory: string, sessionID: string) => [...project(directory), "workflow", "reviews", sessionID] as const,
  workflowAssignments: (directory: string, sessionID: string) =>
    [...project(directory), "workflow", "assignments", sessionID] as const,
  workflowEvents: (directory: string, sessionID: string) => [...project(directory), "workflow", "events", sessionID] as const,
  skills: (directory: string, agent = "") => [...project(directory), "skills", agent] as const,
  mcp: (directory: string) => [...project(directory), "mcp"] as const,
  globalConfig: ["global", "config"] as const,
  globalCompaction: ["global", "compaction"] as const,
  globalMemoryScope: (scope: "user" | "task", sessionID = "") => ["global", "memory", scope, sessionID] as const,
  globalMemory: (scope: "user" | "task", sessionID = "", query = "") =>
    [...keys.globalMemoryScope(scope, sessionID), query] as const,
  globalDefaultPermission: ["global", "default-permission"] as const,
  globalPath: (directory: string) => ["global", "path", normalizeDirectory(directory)] as const,
}
