import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { MemoryPlanEventStore } from "../../src/plan/events"
import { PlanActivationStore } from "../../src/plan/activation"
import { shutdownChildrenFirst } from "../../src/plan/child-termination"
import { stressCount, writeRuntimeMetric } from "./runtime-metrics"

function activationInput(sessionID: string, ownerID: string) {
  return {
    session_id: sessionID,
    parent_session_id: "ses_stress_parent",
    task_id: `stress_${sessionID}`,
    run_id: "run_stress_recovery",
    owner_id: ownerID,
  }
}

describe("plan recovery stress gates", () => {
  test("takes over lost child owners and settles every child before parent cleanup", async () => {
    const count = stressCount("children", 4, 20)
    const started = performance.now()
    let now = 1_000
    const events = new MemoryPlanEventStore()
    const store = new PlanActivationStore({ now: () => now, leaseTtlMs: 10, events })
    const children = Array.from({ length: count }, (_, index) => `ses_stress_child_${index}_${crypto.randomUUID()}`)
    const activations = children.map((sessionID, index) =>
      store.claim(activationInput(sessionID, `owner-crashed-${index}`)),
    )

    now = 10_000
    const recovered = activations.map((activation, index) =>
      store.takeover({ session_id: activation.session_id, owner_id: `owner-recovery-${index}` }),
    )
    expect(recovered.every((activation) => activation.recovery_reason === "owner_lease_expired")).toBe(true)

    const order: string[] = []
    await shutdownChildrenFirst({
      children: children.map((sessionId) => ({ sessionId })),
      stopDispatch: () => order.push("dispatch-stop"),
      markDraining: (sessionId) => {
        order.push(`draining:${sessionId}`)
        const activation = store.get(sessionId)!
        store.transition({
          session_id: sessionId,
          owner_id: activation.owner_id,
          generation: activation.generation,
          state: "draining",
        })
      },
      terminateChild: async (sessionId) => {
        order.push(`settle:${sessionId}`)
        const activation = store.get(sessionId)!
        store.settle({ session_id: sessionId, owner_id: activation.owner_id, generation: activation.generation })
      },
      flushMergeJournals: async () => {
        order.push("merge-flush")
      },
      cleanupWorkspaces: async () => {
        order.push("workspace-cleanup")
      },
      markParentTerminal: async () => {
        order.push("parent-terminal")
      },
    })

    const views = store.list({ now, isOwnerLive: () => false })
    expect(views).toHaveLength(count)
    expect(views.every((view) => view.durable.state === "settled" && !view.live)).toBe(true)
    expect(events.readAfter("ses_stress_parent", -1)).toHaveLength(count)
    expect(order.at(0)).toBe("dispatch-stop")
    expect(order.at(-2)).toBe("workspace-cleanup")
    expect(order.at(-1)).toBe("parent-terminal")

    await writeRuntimeMetric("plan-recovery", {
      children: count,
      duration_ms: Math.round(performance.now() - started),
      recovery_events: count,
      remaining_children: views.filter((view) => view.durable.state !== "settled").length,
      terminal_status: "settled",
    })

    for (const child of children) store.remove(child)
  })

  test("keeps a parent recovery-required when merge journal flush is interrupted", async () => {
    const events: string[] = []
    let parentStatus = "running"
    let failure: unknown
    try {
      await shutdownChildrenFirst({
        children: [{ sessionId: "ses_merge_interrupted" }],
        stopDispatch: () => {
          events.push("dispatch-stop")
        },
        markDraining: () => {
          events.push("draining")
        },
        terminateChild: async () => {
          events.push("settled")
        },
        flushMergeJournals: async () => {
          parentStatus = "recovery_required"
          throw new Error("merge journal interrupted")
        },
        cleanupWorkspaces: async () => {
          events.push("workspace-cleanup")
        },
        markParentTerminal: async () => {
          parentStatus = "terminal"
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ message: "merge journal interrupted" })
    expect(parentStatus).toBe("recovery_required")
    expect(events).toEqual(["dispatch-stop", "draining", "settled"])
  })
})
