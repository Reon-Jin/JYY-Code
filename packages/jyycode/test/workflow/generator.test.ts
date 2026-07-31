import { describe, expect, test } from "bun:test"
import { WorkflowGenerator } from "../../src/workflow/generator"

describe("Workflow generator", () => {
  test("generates a validated workflow with both execution simulations", () => {
    const preview = WorkflowGenerator.preview({ request: "Create a website production workflow" })
    expect(preview.status).toBe("ready")
    expect(preview.interview.map((item) => item.id)).toContain("deliverables")
    expect(preview.interview.map((item) => item.id)).toContain("permissions")
    expect(preview.dryRuns.every((run) => run.valid)).toBe(true)
    expect(preview.validation.every((check) => check.valid)).toBe(true)
    expect(preview.files.map((file) => file.path)).toContain(`.jyycode/workflows/${preview.workflow.id}/workflow.yaml`)
    expect(preview.files.map((file) => file.path)).toContain(`.jyycode/workflows/${preview.workflow.id}/validation-report.json`)
  })

  test("repairs a missing task acceptance rule before validating", () => {
    const workflow = WorkflowGenerator.generate({ request: "Build a project audit workflow" })
    const withoutAcceptance = {
      ...workflow,
      stages: workflow.stages.map((stage) => ({
        ...stage,
        steps: stage.steps.map((step) => ({
          ...step,
          tasks: step.tasks.map((task, index) => (index === 0 ? { ...task, acceptance: [] } : task)),
        })),
      })),
    }
    const repaired = WorkflowGenerator.repair(withoutAcceptance)
    expect(repaired.repaired.length).toBe(3)
    expect(WorkflowGenerator.validate({ workflow: repaired.workflow }).every((check) => check.valid)).toBe(true)
  })
})
