export function normalizeDirectory(directory: string) {
  return directory.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase("en-US")
}

const project = (directory: string) => ["project", normalizeDirectory(directory)] as const

export const keys = {
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
  agentCluster: (directory: string, sessionID: string) =>
    [...project(directory), "agent-clusters", sessionID] as const,
  globalConfig: ["global", "config"] as const,
}
