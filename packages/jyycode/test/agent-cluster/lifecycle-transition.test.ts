import { describe, expect, test } from "bun:test"
import { canTransitionTask, isTerminalTask, deriveRunStatus } from "../../src/agent-cluster/lifecycle"

describe("AgentCluster lifecycle transitions", () => {
  describe("canTransitionTask", () => {
    test("allows every legal transition", () => {
      expect(canTransitionTask("planned", "queued")).toBe(true)
      expect(canTransitionTask("queued", "running")).toBe(true)
      expect(canTransitionTask("queued", "cancelled")).toBe(true)
      expect(canTransitionTask("queued", "failed")).toBe(true)
      expect(canTransitionTask("running", "submitted")).toBe(true)
      expect(canTransitionTask("running", "failed")).toBe(true)
      expect(canTransitionTask("running", "cancelled")).toBe(true)
      expect(canTransitionTask("submitted", "reviewing")).toBe(true)
      expect(canTransitionTask("submitted", "failed")).toBe(true)
      expect(canTransitionTask("submitted", "cancelled")).toBe(true)
      expect(canTransitionTask("reviewing", "accepted")).toBe(true)
      expect(canTransitionTask("reviewing", "revision_requested")).toBe(true)
      expect(canTransitionTask("reviewing", "failed")).toBe(true)
      expect(canTransitionTask("reviewing", "cancelled")).toBe(true)
      expect(canTransitionTask("revision_requested", "revising")).toBe(true)
      expect(canTransitionTask("revision_requested", "failed")).toBe(true)
      expect(canTransitionTask("revision_requested", "cancelled")).toBe(true)
      expect(canTransitionTask("revising", "submitted")).toBe(true)
      expect(canTransitionTask("revising", "failed")).toBe(true)
      expect(canTransitionTask("revising", "cancelled")).toBe(true)
    })

    test("rejects illegal transitions", () => {
      expect(canTransitionTask("running", "accepted")).toBe(false)
      expect(canTransitionTask("accepted", "running")).toBe(false)
      expect(canTransitionTask("accepted", "submitted")).toBe(false)
      expect(canTransitionTask("failed", "running")).toBe(false)
      expect(canTransitionTask("cancelled", "running")).toBe(false)
      expect(canTransitionTask("planned", "accepted")).toBe(false)
      expect(canTransitionTask("planned", "running")).toBe(false)
      expect(canTransitionTask("submitted", "planned")).toBe(false)
      expect(canTransitionTask("revision_requested", "accepted")).toBe(false)
      expect(canTransitionTask("revision_requested", "running")).toBe(false)
      expect(canTransitionTask("revising", "accepted")).toBe(false)
      expect(canTransitionTask("revising", "planned")).toBe(false)
      expect(canTransitionTask("accepted", "revision_requested")).toBe(false)
      expect(canTransitionTask("failed", "accepted")).toBe(false)
      expect(canTransitionTask("cancelled", "accepted")).toBe(false)
    })
  })

  describe("isTerminalTask", () => {
    test("terminal statuses return true", () => {
      expect(isTerminalTask("accepted")).toBe(true)
      expect(isTerminalTask("failed")).toBe(true)
      expect(isTerminalTask("cancelled")).toBe(true)
    })

    test("non-terminal statuses return false", () => {
      expect(isTerminalTask("planned")).toBe(false)
      expect(isTerminalTask("queued")).toBe(false)
      expect(isTerminalTask("running")).toBe(false)
      expect(isTerminalTask("submitted")).toBe(false)
      expect(isTerminalTask("reviewing")).toBe(false)
      expect(isTerminalTask("revision_requested")).toBe(false)
      expect(isTerminalTask("revising")).toBe(false)
    })
  })

  describe("deriveRunStatus", () => {
    test("returns planning when no tasks exist", () => {
      expect(deriveRunStatus([])).toBe("planning")
    })

    test("returns dispatching when queued work exists", () => {
      expect(deriveRunStatus(["queued"])).toBe("dispatching")
      expect(deriveRunStatus(["running"])).toBe("dispatching")
      expect(deriveRunStatus(["revising"])).toBe("dispatching")
      expect(deriveRunStatus(["queued", "accepted"])).toBe("dispatching")
    })

    test("returns reviewing when submitted work exists and no active work", () => {
      expect(deriveRunStatus(["submitted"])).toBe("reviewing")
      expect(deriveRunStatus(["reviewing"])).toBe("reviewing")
      expect(deriveRunStatus(["revision_requested"])).toBe("reviewing")
      expect(deriveRunStatus(["accepted", "submitted"])).toBe("reviewing")
    })

    test("returns completed when all tasks are accepted", () => {
      expect(deriveRunStatus(["accepted"])).toBe("completed")
      expect(deriveRunStatus(["accepted", "accepted"])).toBe("completed")
    })

    test("returns completed when all tasks are terminal with at least one accepted", () => {
      expect(deriveRunStatus(["accepted", "failed"])).toBe("completed")
      expect(deriveRunStatus(["accepted", "cancelled"])).toBe("completed")
    })

    test("returns failed when all tasks are failed or cancelled with no accepted", () => {
      expect(deriveRunStatus(["failed", "cancelled"])).toBe("failed")
    })

    test("returns failed when all tasks are failed or cancelled", () => {
      expect(deriveRunStatus(["failed"])).toBe("failed")
      expect(deriveRunStatus(["cancelled"])).toBe("failed")
      expect(deriveRunStatus(["failed", "cancelled"])).toBe("failed")
    })

    test("dispatching takes precedence over reviewing", () => {
      // Active work (running) means dispatching, even if some tasks are submitted
      expect(deriveRunStatus(["running", "submitted"])).toBe("dispatching")
    })
  })
})
