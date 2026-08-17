import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { MemoryPlanEventStore } from "../../src/plan/events"
import { PlanActivationStore } from "../../src/plan/activation"
import { shutdownChildrenFirst } from "../../src/plan/child-termination"

function activationInput(ownerId: string) {
  const id = crypto.randomUUID()
  return {
    session_id: `child_activation_test_${id}`,
    parent_session_id: `parent_activation_test_${id}`,
    task_id: "s1_t1",
    run_id: "run_activation_test",
    owner_id: ownerId,
  }
}

describe("durable child activation ownership", () => {
  test("allows one live owner and rejects a competing owner", () => {
    const store = new PlanActivationStore({ now: () => 1_000, leaseTtlMs: 10_000 })

    const input = activationInput("owner-a")
    const claimed = store.claim(input)
    expect(claimed.generation).toBe(1)
    expect(() => store.claim({ ...input, owner_id: "owner-b" })).toThrow("activation is owned")
  })

  test("uses generation CAS so a stale owner cannot renew or complete after takeover", () => {
    let now = 1_000
    const events = new MemoryPlanEventStore()
    const store = new PlanActivationStore({ now: () => now, leaseTtlMs: 10_000, events })
    const first = store.claim(activationInput("owner-a"))

    now = 20_000
    const takeover = store.takeover({ session_id: first.session_id, owner_id: "owner-b" })
    expect(takeover.generation).toBe(2)
    expect(() =>
      store.renew({ session_id: first.session_id, owner_id: "owner-a", generation: first.generation }),
    ).toThrow("stale activation generation")
    expect(() =>
      store.transition({
        session_id: first.session_id,
        owner_id: "owner-a",
        generation: first.generation,
        state: "settled",
      }),
    ).toThrow("stale activation generation")

    const recovery = events.readAfter(first.parent_session_id, -1)
    expect(recovery.some((event) => event.type === "child.recovery")).toBe(true)
  })

  test("keeps durable status separate from live activation after a cold start", () => {
    const store = new PlanActivationStore({ now: () => 1_000, leaseTtlMs: 10_000 })
    store.claim(activationInput("owner-crashed"))

    const [view] = store.list({ isOwnerLive: () => false })
    expect(view.durable.state).toBe("starting")
    expect(view.live).toBe(false)
  })
})

describe("parent shutdown ordering", () => {
  test("stops dispatch, drains children, settles them, then flushes and cleans up", async () => {
    const events: string[] = []
    await shutdownChildrenFirst({
      children: [{ sessionId: "child-1" }, { sessionId: "child-2" }],
      stopDispatch: () => events.push("dispatch-stop"),
      markDraining: (sessionId) => {
        events.push(`drain:${sessionId}`)
      },
      terminateChild: async (sessionId) => {
        events.push(`terminate:${sessionId}`)
        events.push(`settle:${sessionId}`)
      },
      flushMergeJournals: async () => {
        events.push("merge-flush")
      },
      cleanupWorkspaces: async () => {
        events.push("workspace-cleanup")
      },
      markParentTerminal: async () => {
        events.push("parent-terminal")
      },
    })

    expect(events).toEqual([
      "dispatch-stop",
      "drain:child-1",
      "drain:child-2",
      "terminate:child-1",
      "settle:child-1",
      "terminate:child-2",
      "settle:child-2",
      "merge-flush",
      "workspace-cleanup",
      "parent-terminal",
    ])
  })
})
