import { describe, expect, test } from "bun:test"
import {
  WorkspaceCleanupService,
  type CleanupRecord,
} from "../../src/plan/workspace-cleanup"

const baseRecord: CleanupRecord = {
  state: "pending",
  attempts: 0,
  updated_at: "2026-08-09T00:00:00.000Z",
}

describe("durable workspace cleanup", () => {
  test("persists failure and retries the same cleanup key idempotently", async () => {
    const service = new WorkspaceCleanupService()
    const records: CleanupRecord[] = []
    let removeCalls = 0
    let failOnce = true
    const input = {
      rootSessionId: "ses_main",
      taskId: "s1_t1",
      workspaceDirectory: "C:/runtime/child",
      record: baseRecord,
      stop: async () => {},
      remove: async () => {
        removeCalls++
        if (failOnce) {
          failOnce = false
          throw Object.assign(new Error("busy"), { code: "EBUSY" })
        }
        return true
      },
      retryDelaysMs: [],
      persist: async (record: CleanupRecord) => {
        records.push(record)
      },
    }

    const first = await service.run(input)
    expect(first.record.state).toBe("failed")
    expect(first.record.attempts).toBe(1)
    expect(records.map((record) => record.state)).toEqual(["pending", "stopping", "deleting", "failed"])

    const second = await service.run({ ...input, record: first.record })
    expect(second.record.state).toBe("completed")
    expect(second.record.attempts).toBe(2)
    expect(removeCalls).toBe(2)

    const completed = await service.run({ ...input, record: second.record })
    expect(completed.changed).toBe(false)
    expect(removeCalls).toBe(2)
  })

  test("coalesces concurrent calls and never removes after stop_failed", async () => {
    const service = new WorkspaceCleanupService()
    const records: CleanupRecord[] = []
    let stopCalls = 0
    let removeCalls = 0
    let release!: () => void
    const stopGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = {
      rootSessionId: "ses_main",
      taskId: "s1_t2",
      workspaceDirectory: "C:/runtime/child-2",
      stop: async () => {
        stopCalls++
        await stopGate
      },
      remove: async () => {
        removeCalls++
        return true
      },
      persist: async (record: CleanupRecord) => {
        records.push(record)
      },
    }
    const first = service.run(input)
    const second = service.run(input)
    release()
    const [left, right] = await Promise.all([first, second])
    expect(left.record.state).toBe("completed")
    expect(right.record.state).toBe("completed")
    expect(stopCalls).toBe(1)
    expect(removeCalls).toBe(1)

    const failed = await new WorkspaceCleanupService().run({
      ...input,
      taskId: "s1_t3",
      stop: async () => ({ state: "stop_failed", phase: "cancel", message: "still busy" }),
    })
    expect(failed.record.state).toBe("failed")
    expect(failed.record.last_error?.phase).toBe("stop")
    expect(removeCalls).toBe(1)
    expect(records.some((record) => record.state === "deleting")).toBe(true)
  })

  test("quarantines unsafe cleanup failures and does not retry them", async () => {
    const service = new WorkspaceCleanupService()
    let removeCalls = 0
    const remove = async () => {
      removeCalls++
      throw Object.assign(new Error("path identity mismatch"), { code: "PATH_IDENTITY_MISMATCH", recoverable: false })
    }
    const input = {
      rootSessionId: "ses_main",
      taskId: "s1_t4",
      workspaceDirectory: "C:/runtime/unsafe",
      stop: async () => {},
      remove,
      persist: async () => {},
    }
    const first = await service.run(input)
    const second = await service.run({ ...input, record: first.record })
    expect(first.record.state).toBe("quarantined")
    expect(second.changed).toBe(false)
    expect(removeCalls).toBe(1)
  })

  test("retries only transient Windows cleanup errors with bounded backoff", async () => {
    const service = new WorkspaceCleanupService()
    const waits: number[] = []
    let calls = 0
    const result = await service.run({
      rootSessionId: "ses_main",
      taskId: "s1_t5",
      workspaceDirectory: "C:/runtime/locked",
      stop: async () => {},
      remove: async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" })
        return true
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
      jitter: () => 0,
      persist: async () => {},
    })
    expect(result.record.state).toBe("completed")
    expect(calls).toBe(3)
    expect(waits).toEqual([100, 250])

    calls = 0
    const permanent = await service.run({
      rootSessionId: "ses_main",
      taskId: "s1_t6",
      workspaceDirectory: "C:/runtime/denied",
      stop: async () => {},
      remove: async () => {
        calls++
        throw Object.assign(new Error("access denied"), { code: "EACCES" })
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
      },
      jitter: () => 0,
      persist: async () => {},
    })
    expect(permanent.record.state).toBe("failed")
    expect(calls).toBe(1)
    expect(waits).toEqual([100, 250])
  })
})
