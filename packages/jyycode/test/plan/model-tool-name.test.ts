import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  candidateToolGateState,
  filterToolIDs,
  hasInFlightPlanTasks,
  intersectToolIDs,
  isPlanToolVisible,
  isSubagentToolVisible,
  requiredPlanTool,
  retainRequiredPlanTools,
  retainOnlyTool,
  shouldWaitForPlanReport,
  subagentRoleToolIDs,
  subagentToolIDs,
  toolNameForModel,
} from "../../src/session/tools"
import {
  BLACKBOARD_INPUT_SCHEMA,
  BLACKBOARD_REPLY_INPUT_SCHEMA,
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
    expect(modelFacingPlanToolName("Blackboard.reply")).toBe("Blackboard_Reply")
    expect(modelFacingPlanToolName("Dispatch.roles")).toBe("Dispatch_roles")
    expect(toolNameForModel("Plan.read")).toBe("Plan_read")
    expect(toolNameForModel("Dispatch.dispatch")).toBe("Dispatch_dispatch")
    expect(toolNameForModel("Dispatch.roles")).toBe("Dispatch_roles")
    expect(toolNameForModel("Report")).toBe("Report")
    expect(toolNameForModel("read")).toBe("read")
    expect(toolNameForModel("Blackboard")).toBe("Blackboard")
    expect(toolNameForModel("Blackboard.reply")).toBe("Blackboard_Reply")
  })

  it("exposes one context-free Blackboard tool with only optional write fields", () => {
    expect(PLAN_TOOL_IDS.has("Blackboard")).toBe(true)
    expect(PLAN_TOOL_IDS.has("Blackboard.reply")).toBe(true)
    expect(PLAN_TOOL_IDS.has("Dispatch.roles")).toBe(true)
    expect(BLACKBOARD_INPUT_SCHEMA.required).toBeUndefined()
    expect(Object.keys(BLACKBOARD_INPUT_SCHEMA.properties!)).toEqual([
      "message",
      "kind",
      "task_ids",
      "reply_to",
      "attachments",
    ])
    expect(Object.keys(BLACKBOARD_INPUT_SCHEMA.properties!).some((key) => /step|sender|session|author|mention/i.test(key))).toBe(false)
    expect(BLACKBOARD_REPLY_INPUT_SCHEMA.required).toEqual(["message", "reply_to"])
  })

  it("limits plan protocol tools by session role", () => {
    expect(isPlanToolVisible("Blackboard", { parentID: "ses_parent" as never, multiAgent: undefined })).toBe(true)
    expect(isPlanToolVisible("Blackboard.reply", { parentID: "ses_parent" as never, multiAgent: undefined })).toBe(true)
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
      expect.arrayContaining(["read", "glob", "grep", "webfetch", "websearch", "skill", "Candidate.submit"]),
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
    expect([...reviewGate!.allowedToolIDs]).toEqual(["Blackboard", "Blackboard.reply", "Candidate.ready"])
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it("enforces profile tool allowlists before phase-specific visibility", () => {
    const role = {
      mode: "subagent",
      options: { subagentToolIDs: ["read", "bash", "plugin_custom", "Candidate.submit"] },
    } as never
    const allowlist = subagentToolIDs(role)
    expect(allowlist).toEqual(new Set(["read", "bash", "plugin_custom", "Candidate.submit"]))
    expect(intersectToolIDs(allowlist, new Set(["read", "Candidate.submit"]))).toEqual(
      new Set(["read", "Candidate.submit"]),
    )
    expect(filterToolIDs([{ id: "read" }, { id: "shell" }, { id: "tool_search" }], new Set(["read"]))).toEqual([
      { id: "read" },
    ])
    expect(filterToolIDs([{ id: "read" }], new Set())).toEqual([])
    expect(subagentToolIDs({ mode: "primary", options: {} } as never)).toBeUndefined()
    expect(subagentToolIDs({ mode: "subagent", options: {} } as never)).toBeUndefined()
    const roleToolIDs = subagentRoleToolIDs(role, { parentID: "parent" as never }, { allowedToolIDs: new Set(["read", "Candidate.submit"]) })
    expect(roleToolIDs).toEqual(new Set(["read", "bash", "plugin_custom", "skill", "Report", "Blackboard", "Blackboard.reply", "Candidate.submit"])
    )
    expect(intersectToolIDs(roleToolIDs, new Set(["read", "Candidate.submit"]))).toEqual(new Set(["read", "Candidate.submit"]))
    // Omitted settings are represented by an undefined gate so the runtime
    // can include currently connected plugin and MCP tools, then remove the
    // reserved system IDs in the catalog filter.
    expect(subagentRoleToolIDs({ mode: "subagent", options: {} } as never, { parentID: "parent" as never })).toBeUndefined()
    expect(isSubagentToolVisible("plugin_custom", undefined, undefined)).toBe(true)
    expect(isSubagentToolVisible("memory", undefined, undefined)).toBe(false)
    expect(isSubagentToolVisible("Plan.read", undefined, undefined)).toBe(false)
    expect(isSubagentToolVisible("Candidate.submit", undefined, undefined)).toBe(false)
    expect(
      isSubagentToolVisible("Candidate.submit", undefined, {
        phase: "running",
        allowedToolIDs: new Set(["Candidate.submit"]),
      }),
    ).toBe(true)
    expect(
      isSubagentToolVisible("plugin_custom", undefined, {
        phase: "running",
        allowedToolIDs: new Set(["read"]),
      }),
    ).toBe(true)
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
    const createTools = {
      Plan_read: {} as never,
      Plan_create: {} as never,
      Dispatch_roles: {} as never,
      Dispatch_dispatch: {} as never,
      Dispatch_cancel: {} as never,
      Plan_update: {} as never,
      Blackboard: {} as never,
      Blackboard_Reply: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(createTools, "Plan_create")
    expect(Object.keys(createTools)).toEqual([
      "Plan_read",
      "Plan_create",
      "Dispatch_roles",
      "Dispatch_dispatch",
      "Dispatch_cancel",
      "Plan_update",
      "Blackboard",
      "Blackboard_Reply",
    ])

    const updateTools = {
      Plan_read: {} as never,
      Plan_update: {} as never,
      Dispatch_dispatch: {} as never,
      Blackboard: {} as never,
      Blackboard_Reply: {} as never,
      Dispatch_roles: {} as never,
      Dispatch_cancel: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(updateTools, "Plan_update")
    expect(Object.keys(updateTools)).toEqual([
      "Plan_read",
      "Plan_update",
      "Blackboard",
      "Blackboard_Reply",
      "Dispatch_roles",
      "Dispatch_cancel",
    ])

    const dispatchTools = {
      Plan_read: {} as never,
      Plan_update: {} as never,
      Dispatch_dispatch: {} as never,
      Blackboard: {} as never,
      Blackboard_Reply: {} as never,
      Dispatch_roles: {} as never,
      Dispatch_cancel: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(dispatchTools, "Dispatch_dispatch")
    expect(Object.keys(dispatchTools)).toEqual([
      "Plan_read",
      "Dispatch_dispatch",
      "Blackboard",
      "Blackboard_Reply",
      "Dispatch_roles",
      "Dispatch_cancel",
    ])

    const blackboardTools = {
      Plan_read: {} as never,
      Blackboard: {} as never,
      Blackboard_Reply: {} as never,
      Plan_update: {} as never,
      bash: {} as never,
    }
    retainRequiredPlanTools(blackboardTools, "Blackboard")
    expect(Object.keys(blackboardTools)).toEqual(["Plan_read", "Blackboard", "Blackboard_Reply", "Plan_update", "bash"])
  })

  it("forces multi-agent roots to create, prepare, and dispatch active work instead of doing it themselves", () => {
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 1 })).toBe("Plan_read")
    expect(requiredPlanTool({ root: true, multiAgent: true, step: 1, blackboardUnread: 2, planExists: false })).toBe(
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
    expect(
      requiredPlanTool({
        root: true,
        multiAgent: true,
        step: 3,
        planExists: true,
        plan: {
          current_step: "s2",
          steps: [
            { id: "s1", tasks: [{ id: "s1_t1", status: "approved", done_criteria: "done", output_path: "s1.md" }] },
            { id: "s2", tasks: [] },
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

  it("waits for a Report instead of polling while no root work is actionable", () => {
    const running = {
      current_step: "s1",
      steps: [{ id: "s1", tasks: [{ id: "s1_t1", status: "running", done_criteria: "x", output_path: "x.md" }] }],
    }
    expect(shouldWaitForPlanReport({ plan: running })).toBe(true)
    expect(shouldWaitForPlanReport({ plan: running, blackboardUnread: 1 })).toBe(false)
    expect(shouldWaitForPlanReport({ plan: running, inboxPending: 1 })).toBe(false)
    expect(
      shouldWaitForPlanReport({
        plan: { ...running, steps: [{ id: "s1", tasks: [{ ...running.steps[0]!.tasks[0]!, status: "reported" }] }] },
      }),
    ).toBe(false)
  })

  it("publishes complete nested schemas for progressive plans and all update operations", () => {
    expect(DISPATCH_INPUT_SCHEMA.required).toEqual(["taskIds", "role"])
    expect(DISPATCH_INPUT_SCHEMA.properties?.role).toMatchObject({ type: "string", minLength: 1 })
    expect(DISPATCH_INPUT_SCHEMA.properties?.taskIds).toMatchObject({ description: expect.stringContaining("every candidate Task ID") })
    const createSteps = PLAN_CREATE_INPUT_SCHEMA.properties?.steps as { items?: unknown }
    expect((PLAN_CREATE_INPUT_SCHEMA.properties?.steps as { description?: string }).description).toContain("one complete 2-3 candidate Task group")
    expect(createSteps.items).toMatchObject({
      required: ["title", "goal", "done_criteria"],
      properties: { tasks: { items: { required: ["title", "goal", "done_criteria"] } } },
    })
    const taskProperties = (createSteps.items as { properties: { tasks: { description?: string; items: { properties: object } } } }).properties.tasks
    expect(taskProperties.description).toContain("2-3 candidate Tasks")
    expect(taskProperties.items.properties).toHaveProperty("instructions")
    expect((taskProperties.items.properties as { mode?: { description?: string } }).mode?.description).toContain("exactly 2-3")

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
        task_title: "Write notes",
        goal: "write notes",
        done_criteria: "notes.md exists",
        workspace_root: "/workspace",
        output_path: "/workspace/notes.md",
        report_format: "Report(...)",
        step_context: {
          plan_goal: "Document the project",
          step_id: "s1",
          step_title: "Notes",
          step_goal: "Document the project notes",
          step_done_criteria: "Notes are published",
        },
      },
      role,
    )
    expect(prompt).toContain("output_path")
    expect(prompt).toContain("## Role instructions (launch only)")
    expect(prompt).toContain("Use the review checklist.")
  })
})
