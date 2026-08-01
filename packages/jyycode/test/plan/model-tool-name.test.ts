import { describe, expect, it } from "bun:test"
import { hasInFlightPlanTasks, requiredPlanTool, retainOnlyTool, toolNameForModel } from "../../src/session/tools"
import { PLAN_CREATE_INPUT_SCHEMA, PLAN_UPDATE_INPUT_SCHEMA } from "../../src/plan/tools"

describe("model-facing plan tool names", () => {
  it("uses provider-safe names without changing ordinary tools", () => {
    expect(toolNameForModel("Plan.read")).toBe("Plan_read")
    expect(toolNameForModel("Dispatch.dispatch")).toBe("Dispatch_dispatch")
    expect(toolNameForModel("Report")).toBe("Report")
    expect(toolNameForModel("read")).toBe("read")
  })

  it("forces Plan_read to be the only first-step tool", () => {
    const tools = {
      Plan_read: {} as never,
      Plan_create: {} as never,
      Dispatch_dispatch: {} as never,
      bash: {} as never,
    }
    retainOnlyTool(tools, "Plan_read")
    expect(Object.keys(tools)).toEqual(["Plan_read"])
    expect(() => retainOnlyTool({}, "Plan_read")).toThrow("Required tool is unavailable")
  })

  it("forces multi-agent roots to create, prepare, and dispatch active work instead of doing it themselves", () => {
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 1 })).toBe("Plan_read")
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 2, planExists: false })).toBe("Plan_create")
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 3, planExists: true })).toBeUndefined()
    expect(
      requiredPlanTool({
        root: true,
        multiAgent: true,
        step: 3,
        planExists: true,
        plan: {
          current_step: "s1",
          steps: [
            {
              id: "s1",
              tasks: [
                { id: "s1_t1", status: "pending", done_criteria: "write notes", output_path: "notes.md" },
                { id: "s1_t2", status: "rejected", done_criteria: "write tests", output_path: "tests.md" },
              ],
            },
          ],
        },
      }),
    ).toBe("Dispatch_dispatch")
    expect(
      requiredPlanTool({
        root: true,
        multiAgent: true,
        step: 3,
        planExists: true,
        plan: {
          current_step: "s1",
          steps: [
            {
              id: "s1",
              tasks: [{ id: "s1_t1", status: "pending", done_criteria: "write notes", output_path: null }],
            },
          ],
        },
      }),
    ).toBe("Plan_update")
    expect(requiredPlanTool({ root: true, multiAgent: false, step: 2, planExists: false })).toBeUndefined()
    expect(requiredPlanTool({ root: false, multiAgent: true, step: 1, planExists: false })).toBeUndefined()
  })

  it("yields the root turn while dispatched work is running", () => {
    expect(
      hasInFlightPlanTasks({
        current_step: "s1",
        steps: [{ id: "s1", tasks: [{ id: "s1_t1", status: "running", done_criteria: "x", output_path: "x.md" }] }],
      }),
    ).toBe(true)
    expect(
      hasInFlightPlanTasks({
        current_step: "s1",
        steps: [{ id: "s1", tasks: [{ id: "s1_t1", status: "reported", done_criteria: "x", output_path: "x.md" }] }],
      }),
    ).toBe(false)
  })

  it("publishes complete nested schemas for progressive plans and all update operations", () => {
    const createSteps = PLAN_CREATE_INPUT_SCHEMA.properties?.steps as { items?: unknown }
    expect(createSteps.items).toMatchObject({
      required: ["title", "goal", "done_criteria"],
      properties: { tasks: { items: { required: ["title", "goal", "done_criteria"] } } },
    })

    const updateOps = PLAN_UPDATE_INPUT_SCHEMA.properties?.ops as { items?: { oneOf?: unknown[] } }
    const operations = updateOps.items?.oneOf ?? []
    expect(operations).toHaveLength(9)
    expect(operations.map((operation) => (operation as { properties: { op: { const: string } } }).properties.op.const))
      .toEqual([
        "edit_plan",
        "add_step",
        "edit_step",
        "remove_step",
        "add_task",
        "edit_task",
        "remove_task",
        "set_task_status",
        "review_task",
      ])
    expect(operations.at(-1)).toMatchObject({ then: { required: ["feedback"] } })
  })
})
