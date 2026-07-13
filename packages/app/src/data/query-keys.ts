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
  session: (directory: string, sessionID: string) => [...project(directory), "session", sessionID] as const,
  messages: (directory: string, sessionID: string) =>
    [...project(directory), "session", sessionID, "messages"] as const,
  status: (directory: string) => [...project(directory), "status"] as const,
  permissions: (directory: string) => [...project(directory), "permissions"] as const,
  questions: (directory: string) => [...project(directory), "questions"] as const,
}
