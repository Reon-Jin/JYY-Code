import { Log } from "@jyycode-ai/core/util/log"

/** Lightweight lifecycle hook; importing session run state must not load native/model workers. */
const sessions = new Map<string, () => Promise<void>>()
const log = Log.create({ service: "computer-resources" })

export function registerComputerSession(sessionID: string, cleanup: () => Promise<void>) {
  sessions.set(sessionID, cleanup)
}

export function hasComputerSessions() {
  return sessions.size > 0
}

export async function releaseComputerSession(sessionID: string) {
  const cleanup = sessions.get(sessionID)
  sessions.delete(sessionID)
  // Cleanup failures must not prevent Runner from resolving cancellation and publishing idle.
  await cleanup?.().catch((error) => log.warn("computer resource cleanup failed", { sessionID, error }))
}

export * as ComputerResources from "./resources"
