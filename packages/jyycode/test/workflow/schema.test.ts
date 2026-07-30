import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowSchema } from "../../src/workflow/schema"
import { WorkflowStateMachine } from "../../src/workflow/state-machine"
import { validatePatch, validateRunPlan, validateWorkflow, WorkflowValidationError } from "../../src/workflow/validation"
import { WorkflowEvent } from "../../src/workflow/event"
import { applyPlanPatch } from "../../src/workflow/runtime"

const decode = Schema.decodeUnknownSync(WorkflowSchema.Workflow)
const workflow = () =>
  decode({
    id: "general",
    version: "2.0.0",
    displayName: "General engineering",
    supports: { single: true, multi: true },
    stages: [
      {
        id: "discovery",
        title: "Discovery",
        dependsOn: [],
        steps: [{ id: "inspect", title: "Inspect", dependsOn: [], tasks: [{ id: "scan", title: "Scan", dependsOn: [], acceptance: [] }] }],
      },
    ],
  })

describe("workflow schema", () => {
  test("decodes a workflow and rejects invalid execution modes", () => {
    expect(workflow().displayName).toBe("General engineering")
    expect(() => Schema.decodeUnknownSync(WorkflowSchema.ExecutionMode)("cluster")).toThrow()
  })

  test("rejects unknown dependencies and cycles", () => {
    const unknown = workflow()
    ;(unknown.stages[0]!.dependsOn as unknown as string[]).push("missing")
    expect(() => validateWorkflow(unknown)).toThrow(WorkflowValidationError)

    const cyclic = workflow()
    const task = cyclic.stages[0]!.steps[0]!.tasks[0]!
    ;(task.dependsOn as unknown as string[]).push(task.id)
    expect(() => validateWorkflow(cyclic)).toThrow("cannot depend on itself")
  })
})

describe("workflow state machine", () => {
  test("enforces review and rework gates", () => {
    expect(WorkflowStateMachine.canTransition("submitted", "accepted")).toBe(false)
    expect(WorkflowStateMachine.canTransition("submitted", "reviewing")).toBe(true)
    expect(WorkflowStateMachine.canTransition("revising", "interrupted")).toBe(true)
    expect(() => WorkflowStateMachine.assertTransition("running", "accepted")).toThrow()
    expect(WorkflowStateMachine.allowedTransitions("reviewing")).toEqual(["accepted", "revision_requested"])
  })
})

describe("workflow events", () => {
  test("keeps event types explicit and session-scoped", () => {
    const event = Schema.decodeUnknownSync(WorkflowEvent.Event)({
      id: "evt_1",
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      type: "RunPlanCreated",
      runPlanID: "plan-1",
      payload: { source: "agent" },
      createdAt: 1,
    })
    expect(event.type).toBe("RunPlanCreated")
    expect(() => Schema.decodeUnknownSync(WorkflowEvent.EventType)("PlanUpdated")).toThrow()
  })
})

describe("plan patch validation", () => {
  test("rejects stale patches before they can update a plan", () => {
    const plan = Schema.decodeUnknownSync(WorkflowSchema.RunPlan)({
      id: "plan-1",
      sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
      workflowID: "general",
      workflowVersion: "2.0.0",
      version: 2,
      mode: "single",
      goal: "Ship it",
      tasks: [{ id: "scan", title: "Scan", stageID: "discovery", stepID: "inspect", dependsOn: [], status: "planned", acceptance: [] }],
      createdAt: 1,
      updatedAt: 1,
    })
    validateRunPlan(plan)
    expect(() => validatePatch(plan, { baseVersion: 1, reason: "stale", operations: [{ type: "set_mode", mode: "multi" }] })).toThrow(
      "Plan version conflict",
    )
  })

  test("applies an optimistic patch as the next immutable version", () => {
    const plan = Schema.decodeUnknownSync(WorkflowSchema.RunPlan)({
      id: "plan-2", sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K", workflowID: "general", workflowVersion: "2.0.0",
      version: 1, mode: "single", goal: "Ship it", createdAt: 1, updatedAt: 1,
      tasks: [{ id: "scan", title: "Scan", stageID: "discovery", stepID: "inspect", dependsOn: [], status: "planned", acceptance: [] }],
    })
    const next = applyPlanPatch(plan, { baseVersion: 1, reason: "parallelize", operations: [{ type: "set_mode", mode: "multi" }] })
    expect(next.version).toBe(2)
    expect(next.mode).toBe("multi")
    expect(plan.mode).toBe("single")
  })
})
