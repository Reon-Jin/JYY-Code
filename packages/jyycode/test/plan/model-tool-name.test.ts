import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  candidateToolGateState,
  hasInFlightPlanTasks,
  isPlanToolVisible,
  requiredPlanTool,
  retainRequiredPlanTools,
  retainOnlyTool,
  toolNameForModel,
} from "../../src/session/tools"
import {
  BLACKBOARD_INPUT_SCHEMA,
  childLaunchPrompt,
  childModelForRole,
  DISPATCH_INPUT_SCHEMA,
  modelFacingPlanToolName,
  PLAN_CREATE_INPUT_SCHEMA,
  PLAN_UPDATE_INPUT_SCHEMA,
  PLAN_TOOL_IDS,
} from "../../src/plan/tools"

describe("model-facing plan tool names", () => {
  it("uses one underscore-separated name on the model wire", () => {
    expect(modelFacingPlanToolName("Plan.read")).toBe("Plan_read")
    expect(modelFacingPlanToolName("Candidate.submit")).toBe("Candidate_submit")
    expect(toolNameForModel("Plan.read")).toBe("Plan_read")
    expect(toolNameForModel("Dispatch.dispatch")).toBe("Dispatch_dispatch")
    expect(toolNameForModel("Report")).toBe("Report")
    expect(toolNameForModel("read")).toBe("read")
    expect(toolNameForModel("Blackboard")).toBe("Blackboard")
  })

  it("exposes one context-free Blackboard tool with only optional write fields", () => {
    expect(PLAN_TOOL_IDS.has("Blackboard")).toBe(true)
    expect(BLACKBOARD_INPUT_SCHEMA.required).toBeUndefined()
    expect(Object.keys(BLACKBOARD_INPUT_SCHEMA.properties!)).toEqual([
      "message",
      "kind",
      "task_ids",
      "reply_to",
      "attachments",
    ])
    expect(Object.keys(BLACKBOARD_INPUT_SCHEMA.properties!).some((key) => /step|sender|session|author|mention/i.test(key))).toBe(false)
  })

  it("limits plan protocol tools by session role", () => {
    expect(isPlanToolVisible("Blackboard", { parentID: "ses_parent" as never, multiAgent: undefined })).toBe(true)
    expect(isPlanToolVisible("Plan.read", { parentID: "ses_parent" as never, multiAgent: undefined })).toBe(false)
    expect(isPlanToolVisible("Blackboard", { parentID: undefined, multiAgent: false })).toBe(false)
    expect(isPlanToolVisible("Blackboard", { parentID: undefined, multiAgent: true })).toBe(true)
  })

  it("derives candidate child tools from the dispatched task and persisted phase", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-candidate-gate-"))
    const rootSession = "candidate-gate-root"
    const planDirectory = `${workspace}/.jyycode/plan/${rootSession}`
    fs.mkdirSync(planDirectory, { recursive: true })
    fs.writeFileSync(
      `${planDirectory}/plan.json`,
      JSON.stringify({
        title: "Candidate gate",
        goal: "test",
        status: "active",
        revision: 2,
        current_step: "s1",
        steps: [
          {
            id: "s1",
            title: "Candidates",
            goal: "test",
            done_criteria: "choose",
            status: "active",
            candidate_discussion: { phase: "running", ready_task_ids: ["s1_t1", "s1_t2"] },
            tasks: [
              {
                id: "s1_t1",
                title: "A",
                goal: "a",
                done_criteria: "a",
                output_path: ".jyycode/plan/candidate-gate-root/candidates/s1/s1_t1/proposal.md",
                mode: "candidate",
                status: "running",
                dispatch: {
                  run_id: "run__candidate-gate-root__s1_t1",
                  child_session_id: "candidate-child",
                  dispatched_at: new Date().toISOString(),
                  cancelled_at: null,
                },
                report: null,
              },
              {
                id: "s1_t2",
                title: "B",
                goal: "b",
                done_criteria: "b",
                output_path: ".jyycode/plan/candidate-gate-root/candidates/s1/s1_t2/proposal.md",
                mode: "candidate",
                status: "running",
                dispatch: null,
                report: null,
              },
            ],
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    )
    const gate = candidateToolGateState({
      id: "candidate-child" as never,
      parentID: rootSession as never,
      directory: workspace,
    })
    expect(gate?.phase).toBe("running")
    expect([...gate!.allowedToolIDs]).toEqual(
      expect.arrayContaining(["read", "glob", "grep", "webfetch", "websearch", "Candidate.submit"]),
    )
    expect(gate!.allowedToolIDs.has("shell")).toBe(false)
    expect(gate!.allowedToolIDs.has("Report")).toBe(false)
    const persistedPath = `${planDirectory}/plan.json`
    const persisted = JSON.parse(fs.readFileSync(persistedPath, "utf8")) as { steps: Array<{ candidate_discussion: { phase: string } }> }
    persisted.steps[0]!.candidate_discussion.phase = "declaring"
    fs.writeFileSync(persistedPath, JSON.stringify(persisted))
    const declaringGate = candidateToolGateState({ id: "candidate-child" as never, parentID: rootSession as never, directory: workspace })
    expect([...declaringGate!.allowedToolIDs]).toEqual(["Candidate.declare"])
    persisted.steps[0]!.candidate_discussion.phase = "cross_review"
    fs.writeFileSync(persistedPath, JSON.stringify(persisted))
    const reviewGate = candidateToolGateState({ id: "candidate-child" as never, parentID: rootSession as never, directory: workspace })
    expect([...reviewGate!.allowedToolIDs]).toEqual(["Blackboard", "Candidate.ready"])
    fs.rmSync(workspace, { recursive: true, force: true })
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

  it("keeps Plan_read available to recover a rejected update or dispatch", () => {
    const updateTools = {
      Plan_read: {} as never,
      Plan_update: {} as never,
      Dispatch_dispatch: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(updateTools, "Plan_update")
    expect(Object.keys(updateTools)).toEqual(["Plan_read", "Plan_update"])

    const dispatchTools = {
      Plan_read: {} as never,
      Plan_update: {} as never,
      Dispatch_dispatch: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(dispatchTools, "Dispatch_dispatch")
    expect(Object.keys(dispatchTools)).toEqual(["Plan_read", "Dispatch_dispatch"])
  })

  it("forces multi-agent roots to create, prepare, and dispatch active work instead of doing it themselves", () => {
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 1 })).toBe("Plan_read")
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 2, blackboardUnread: 2, planExists: false })).toBe(
      "Blackboard",
    )
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
    expect(DISPATCH_INPUT_SCHEMA.required).toEqual(["taskIds", "role"])
    expect(DISPATCH_INPUT_SCHEMA.properties?.role).toMatchObject({ type: "string", minLength: 1 })
    const createSteps = PLAN_CREATE_INPUT_SCHEMA.properties?.steps as { items?: unknown }
    expect(createSteps.items).toMatchObject({
      required: ["title", "goal", "done_criteria"],
      properties: { tasks: { items: { required: ["title", "goal", "done_criteria"] } } },
    })

    const updateOps = PLAN_UPDATE_INPUT_SCHEMA.properties?.ops as { items?: { oneOf?: unknown[] } }
    const operations = updateOps.items?.oneOf ?? []
    expect(operations).toHaveLength(10)
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
        "select_candidate",
      ])
    expect(operations.find((operation) => (operation as { properties?: { op?: { const?: string } } }).properties?.op?.const === "review_task"))
      .toMatchObject({ then: { required: ["feedback"] } })
  })

  it("builds child launches from the frozen role snapshot", () => {
    const role = {
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      prompt: "Use the review checklist.",
      avatar: "bug" as const,
      model: "openai/gpt-5",
      variant: "low",
    }
    expect(childModelForRole({ id: ModelID.make("root-model"), providerID: ProviderID.make("root-provider"), variant: "high" }, role)).toEqual({
      id: ModelID.make("gpt-5"),
      providerID: ProviderID.make("openai"),
      variant: "low",
    })
    expect(childModelForRole({ id: ModelID.make("root-model"), providerID: ProviderID.make("root-provider"), variant: "high" }, { ...role, model: undefined })).toEqual({
      id: ModelID.make("root-model"),
      providerID: ProviderID.make("root-provider"),
      variant: "low",
    })
    const prompt = childLaunchPrompt(
      {
        run_id: "run__ses_root__s1_t1",
        goal: "write notes",
        done_criteria: "notes.md exists",
        output_path: "notes.md",
        report_format: "Report(...)",
      },
      role,
    )
    expect(prompt).toContain("output_path")
    expect(prompt).toContain("## Role instructions (launch only)")
    expect(prompt).toContain("Use the review checklist.")
  })
})
