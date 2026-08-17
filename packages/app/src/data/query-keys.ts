import { normalizeDirectory } from "../platform/desktop-path"
export { normalizeDirectory } from "../platform/desktop-path"

const project = (directory: string) => ["project", normalizeDirectory(directory)] as const

export type WorkspaceQueryScope = {
  directory: string
  workspaceID?: string
  sessionID?: string
  relativePath?: string
}

export const normalizeRelativePath = (relativePath = "") => {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")
  return normalized === "." ? "" : normalized
}

const workspaceScope = (scope: WorkspaceQueryScope) => [
  ...project(scope.directory),
  "workspace",
  scope.workspaceID ?? "",
  "session",
  scope.sessionID ?? "",
  "path",
  normalizeRelativePath(scope.relativePath),
] as const

const scopedKey = (kind: string, scope: WorkspaceQueryScope, ...parts: readonly unknown[]) => [
  ...workspaceScope(scope),
  kind,
  ...parts,
] as const

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
  compaction: (directory: string, sessionID: string) =>
    [...project(directory), "session", sessionID, "compaction"] as const,
  status: (directory: string) => [...project(directory), "status"] as const,
  permissions: (directory: string) => [...project(directory), "permissions"] as const,
  questions: (directory: string) => [...project(directory), "questions"] as const,
  vcsInfo: (directory: string) => [...project(directory), "vcs", "info"] as const,
  vcsBranches: (directory: string) => [...project(directory), "vcs", "branches"] as const,
  vcsDiff: (directory: string, workspaceID?: string, sessionID?: string, relativePath?: string) =>
    workspaceID || sessionID || relativePath
      ? scopedKey("vcs-diff", { directory, workspaceID, sessionID, relativePath })
      : ([...project(directory), "vcs", "diff"] as const),
  sessionDiff: (directory: string, workspaceID = "", sessionID = "", relativePath = "") =>
    scopedKey("session-diff", { directory, workspaceID, sessionID, relativePath }),
  fileList: (directory: string, workspaceID = "", sessionID = "", relativePath = "") =>
    scopedKey("files", { directory, workspaceID, sessionID, relativePath }, "list"),
  fileContent: (directory: string, workspaceID = "", sessionID = "", relativePath = "") =>
    scopedKey("files", { directory, workspaceID, sessionID, relativePath }, "content"),
  githubStatus: (directory: string) => [...project(directory), "github", "status"] as const,
  pullRequestsScope: (directory: string) => [...project(directory), "github", "pulls"] as const,
  pullRequests: (directory: string, state: "open" | "closed" | "merged" | "all") =>
    [...project(directory), "github", "pulls", state] as const,
  pullRequest: (directory: string, number: number) => [...project(directory), "github", "pull", number] as const,
  pullRequestDiff: (directory: string, number: number) =>
    [...project(directory), "github", "pull", number, "diff"] as const,
  plansScope: (directory: string) => [...project(directory), "plans"] as const,
  plan: (directory: string, sessionID: string) => [...project(directory), "plans", sessionID] as const,
  blackboardsScope: (directory: string) => [...project(directory), "blackboards"] as const,
  blackboard: (directory: string, rootSessionID: string) =>
    [...keys.blackboardsScope(directory), rootSessionID] as const,
  blackboardStep: (directory: string, rootSessionID: string, stepID: string) =>
    [...keys.blackboard(directory, rootSessionID), "step", stepID] as const,
  skills: (directory: string, agent = "") => [...project(directory), "skills", agent] as const,
  subagents: (directory: string) => [...project(directory), "subagents"] as const,
  subagentTools: (directory: string) => [...project(directory), "subagent-tools"] as const,
  mcp: (directory: string) => [...project(directory), "mcp"] as const,
  globalConfig: ["global", "config"] as const,
  globalCompaction: ["global", "compaction"] as const,
  globalMemoryScope: (scope: "user" | "task" | "experience", sessionID = "") =>
    ["global", "memory", scope, sessionID] as const,
  globalMemory: (scope: "user" | "task" | "experience", sessionID = "", query = "") =>
    [...keys.globalMemoryScope(scope, sessionID), query] as const,
  globalDefaultPermission: ["global", "default-permission"] as const,
  globalPath: (directory: string) => ["global", "path", normalizeDirectory(directory)] as const,
}
