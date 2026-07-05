import { describe, expect, test } from "bun:test"
import { AgentClusterIntervention } from "../../src/agent-cluster/intervention"

describe("AgentCluster intervention interrupt", () => {
  test("interventionText includes interrupt prefix for interrupt mode", () => {
    const text = AgentClusterIntervention.interventionText({
      source: "user",
      mode: "interrupt",
      sequence: 1,
      content: "Stop and fix the race condition first",
      id: "iv_123",
    })
    expect(text).toContain("interrupt")
    expect(text).toContain("⚠️ The user has interrupted your work")
    expect(text).toContain("Stop and fix the race condition first")
  })

  test("interventionText for next_checkpoint does not include interrupt prefix", () => {
    const text = AgentClusterIntervention.interventionText({
      source: "user",
      mode: "next_checkpoint",
      sequence: 2,
      content: "Check the file output",
      id: "iv_456",
    })
    expect(text).not.toContain("interrupted")
    expect(text).toContain("Check the file output")
  })

  test("interventionText for parent_only uses Coordinator note label", () => {
    const text = AgentClusterIntervention.interventionText({
      source: "primary",
      mode: "parent_only",
      sequence: 1,
      content: "Child is running slowly",
      id: "iv_789",
    })
    expect(text).toContain("Coordinator note")
    expect(text).toContain("Child is running slowly")
  })

  test("child gate prevents concurrent access per session", async () => {
    const { acquireChildGate, releaseChildGate } = AgentClusterIntervention

    // First acquisition succeeds immediately
    const p1 = acquireChildGate("ses_child")
    expect(p1).toBeUndefined() // acquired synchronously

    // Second acquisition returns a pending promise
    const p2 = acquireChildGate("ses_child")
    expect(p2).toBeInstanceOf(Promise)

    // Release the gate - p2 should resolve
    releaseChildGate("ses_child")
    await p2

    // Now gate is free again
    const p3 = acquireChildGate("ses_child")
    expect(p3).toBeUndefined()
    releaseChildGate("ses_child")
  })

  test("child gate is per-session (different sessions don't conflict)", () => {
    const { acquireChildGate, releaseChildGate } = AgentClusterIntervention

    const pA = acquireChildGate("ses_a")
    const pB = acquireChildGate("ses_b")

    expect(pA).toBeUndefined()
    expect(pB).toBeUndefined() // different session, no conflict

    releaseChildGate("ses_a")
    releaseChildGate("ses_b")
  })
})
