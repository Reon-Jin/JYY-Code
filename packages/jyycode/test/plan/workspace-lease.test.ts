import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import {
  DEFAULT_WORKSPACE_LEASE_TTL_MS,
  WorkspaceLeaseStore,
  leaseIsExpired,
  readWorkspaceLease,
  workspaceLeasePath,
} from "../../src/plan/workspace-lease"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("workspace lease", () => {
  it("writes canonical metadata and refreshes expiry with a heartbeat", () => {
    const runtimeRoot = tempDirectory("jyycode-lease-")
    const workspace = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab")
    fs.mkdirSync(workspace)
    let now = Date.parse("2026-08-09T00:00:00.000Z")
    const store = new WorkspaceLeaseStore({ runtimeRoot, now: () => now })
    const lease = store.create({
      workspace_directory: workspace,
      root_session_id: "ses_main",
      task_id: "s1_t1",
      run_id: "run__ses_main__s1_t1",
      session_id: "ses_child",
    })
    expect(lease.workspace_directory).toBe(fs.realpathSync.native(workspace))
    expect(Date.parse(lease.expires_at) - now).toBe(DEFAULT_WORKSPACE_LEASE_TTL_MS)
    expect(readWorkspaceLease(workspaceLeasePath(workspace))?.session_id).toBe("ses_child")
    now += 30_000
    const refreshed = store.heartbeat(workspace, { sessionId: "ses_child" })!
    expect(Date.parse(refreshed.expires_at)).toBe(now + DEFAULT_WORKSPACE_LEASE_TTL_MS)
    expect(leaseIsExpired(refreshed, now)).toBe(false)
  })

  it("rejects a heartbeat from a different child session", () => {
    const runtimeRoot = tempDirectory("jyycode-lease-")
    const workspace = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab")
    fs.mkdirSync(workspace)
    const store = new WorkspaceLeaseStore({ runtimeRoot })
    store.create({
      workspace_directory: workspace,
      root_session_id: "ses_main",
      task_id: "s1_t1",
      run_id: "run",
      session_id: "ses_child",
    })
    expect(() => store.heartbeat(workspace, { sessionId: "other" })).toThrow("session mismatch")
  })
})
