import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  agentClusterSnapshot,
  extractAgentClusterPlan,
  stripAgentClusterPlanText,
} from "../../src/cli/cmd/tui/routes/session/agent-cluster-state"
import { applyAgentClusterEvent, type AgentClusterState } from "../../src/cli/cmd/tui/context/sync"
import { taskStatusRank } from "../../src/cli/cmd/tui/component/task-item"
import { visibleTaskRows } from "../../src/cli/cmd/tui/feature-plugins/sidebar/tasks"
import { shouldShowTodoPanel } from "../../src/cli/cmd/tui/feature-plugins/sidebar/todo"
import { AgentClusterStatePayload } from "../../src/server/routes/instance/httpapi/groups/session"

const task = (input: { id: string; step: number; title: string; role: string; status: string; dependencies?: string[] }) => ({
  id: input.id,
  session_id: "ses_parent",
  origin_message_id: null,
  parent_task_id: null,
  child_session_id: null,
  role: input.role as any,
  title: input.title,
  prompt: input.title,
  complexity: "simple" as const,
  model: "test/simple",
  status: input.status as any,
  step: input.step,
  dependencies: input.dependencies ?? [],
  review_round: 0,
  acceptance_criteria: [],
  artifact_paths: [],
  result_summary: null,
  review_issues: [],
  last_event: null,
  time_created: 1,
  time_updated: 1,
})

describe("agent cluster session task graph", () => {
  test("HTTP payload preserves durable session task topology", () => {
    const payload = { tasks: [task({ id: "copy", step: 2, title: "Copy", role: "coder", status: "planned", dependencies: ["create"] })] }
    expect(Schema.encodeUnknownSync(AgentClusterStatePayload)(payload as any)).toEqual(payload)
  })

  test("projects global task steps and statuses without a run layer", () => {
    const snapshot = agentClusterSnapshot({
      sessionID: "ses_parent",
      enabled: true,
      disabled: false,
      cluster: {
        tasks: [
          task({ id: "research", step: 1, title: "Research", role: "researcher", status: "accepted" }),
          task({ id: "write", step: 2, title: "Write", role: "writer", status: "running", dependencies: ["research"] }),
          task({ id: "review", step: 3, title: "Review", role: "tester", status: "planned", dependencies: ["write"] }),
        ],
      },
      messages: () => [],
      parts: () => [],
    })
    expect(snapshot.steps.map((step) => [step.index, step.status])).toEqual([[1, "done"], [2, "running"], [3, "queued"]])
    expect(snapshot.currentStep).toBe(2)
    expect(snapshot.plan?.tasks.map((item) => item.id)).toEqual(["research", "write", "review"])
  })

  test("applies task events by id and keeps todo hidden", () => {
    const state: AgentClusterState = { tasks: [task({ id: "write", step: 1, title: "Write", role: "writer", status: "running" })] }
    const next = applyAgentClusterEvent(state, {
      type: "agent_cluster.event",
      properties: { sessionID: "ses_parent", taskID: "write", type: "task", status: "interrupted", message: "User steered child", createdAt: 2 },
    } as never)
    expect(next.tasks[0]?.status).toBe("interrupted")
    expect(next.tasks[0]?.last_event).toBe("User steered child")
    expect(shouldShowTodoPanel({ cluster: next, todos: [] } as never)).toBe(false)
  })

  test("orders active rows before queued work", () => {
    const rows = visibleTaskRows([
      { id: "queued", status: "queued", task: "Queued" },
      { id: "active", status: "running", task: "Active" },
    ] as never)
    expect(rows.map((row) => row.id)).toEqual(["active", "queued"])
    expect(taskStatusRank("running")).toBeLessThan(taskStatusRank("queued"))
  })

  test("extracts and hides a fenced plan JSON block", () => {
    const text = 'Plan:\n```json\n{"goal":"Build","tasks":[{"id":"build","step":1,"title":"Build","role":"coder","complexity":"simple","model":"test/simple","dependencies":[],"prompt":"Build it","acceptanceCriteria":[],"expectedArtifacts":[]}]}\n```'
    expect(extractAgentClusterPlan(text)?.tasks[0]?.id).toBe("build")
    expect(stripAgentClusterPlanText(text)).not.toContain('"goal"')
  })
})
