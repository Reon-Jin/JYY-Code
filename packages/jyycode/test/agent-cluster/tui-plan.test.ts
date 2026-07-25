import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@jyycode-ai/sdk/v2"
import {
  agentClusterSnapshot,
  extractAgentClusterPlan,
  stripAgentClusterPlanText,
} from "../../src/cli/cmd/tui/routes/session/agent-cluster-state"
import {
  applyAgentClusterEvent,
  type AgentClusterState,
} from "../../src/cli/cmd/tui/context/sync"
import { taskStatusRank } from "../../src/cli/cmd/tui/component/task-item"
import { visibleTaskRows } from "../../src/cli/cmd/tui/feature-plugins/sidebar/tasks"
import { shouldShowTodoPanel } from "../../src/cli/cmd/tui/feature-plugins/sidebar/todo"
import { AgentClusterStatePayload } from "../../src/server/routes/instance/httpapi/groups/session"
import { Schema } from "effect"

const planJson = JSON.stringify({
  goal: "Build a detailed report",
  tasks: [
    {
      id: "research",
      step: 1,
      title: "Research sources",
      role: "researcher",
      complexity: "complex",
      model: "deepseek/deepseek-v4-pro",
      dependencies: [],
      prompt: "Research the topic",
      acceptanceCriteria: ["sources collected"],
      expectedArtifacts: ["research.md"],
    },
    {
      id: "write",
      step: 2,
      title: "Write report",
      role: "writer",
      complexity: "complex",
      model: "deepseek/deepseek-v4-pro",
      dependencies: ["research"],
      prompt: "Write the report",
      acceptanceCriteria: ["report complete"],
      expectedArtifacts: ["report.md"],
    },
  ],
})

describe("agent cluster TUI plan parsing", () => {
  test("agent cluster HTTP payload preserves persisted step topology", () => {
    const encoded = Schema.encodeUnknownSync(AgentClusterStatePayload)({
      tasks: [
        {
          id: "copy-2",
          session_id: "ses_parent",
          origin_message_id: null,
          parent_task_id: null,
          child_session_id: null,
          role: "coder",
          title: "Copy 2.txt",
          prompt: "Copy 1.txt into 2.txt",
          complexity: "simple",
          model: "test/simple",
          status: "planned",
          step: 2,
          dependencies: ["create-1"],
          review_round: 0,
          acceptance_criteria: ["2.txt matches 1.txt"],
          artifact_paths: ["2.txt"],
          result_summary: null,
          review_issues: [],
          last_event: null,
          time_created: 1,
          time_updated: 1,
        },
      ],
    } as any)

    expect(encoded.tasks[0]).toMatchObject({
      step: 2,
      dependencies: ["create-1"],
      result_summary: null,
      review_issues: [],
    })
  })

  test("task status order puts running before queued", () => {
    expect(taskStatusRank("running")).toBeLessThan(taskStatusRank("queued"))
  })

  test("visible cluster tasks include active plus recent done", () => {
    const rows = visibleTaskRows([
      { id: "a", status: "done", title: "A" },
      { id: "b", status: "running", title: "B" },
    ])

    expect(rows.map((row) => row.id)).toEqual(["b", "a"])
  })

  test("todo panel is hidden when structured cluster tasks exist", () => {
    expect(shouldShowTodoPanel({ todoCount: 2, openTodoCount: 1, clusterTaskCount: 1 })).toBe(false)
  })

  test("agent_cluster.event updates task status by task id", () => {
    const initial: AgentClusterState = {
      tasks: [
        {
          id: "inspect",
          session_id: "ses_parent",
          origin_message_id: "msg_user",
          parent_task_id: null,
          child_session_id: null,
          role: "researcher",
          title: "Inspect code",
          prompt: "Inspect code",
          complexity: "simple",
          model: "test/simple",
          status: "planned",
          step: 1,
          dependencies: [],
          review_round: 0,
          acceptance_criteria: [],
          artifact_paths: [],
          result_summary: null,
          review_issues: [],
          last_event: null,
          time_created: 1,
          time_updated: 1,
        },
      ],
    }

    const next = applyAgentClusterEvent(initial, {
      id: "evt_1",
      type: "agent_cluster.event",
      properties: {
        sessionID: "ses_parent",
        taskID: "inspect",
        type: "task",
        status: "running",
        message: "inspect running",
        createdAt: 2,
      },
    })

    expect(next.tasks.find((task) => task.id === "inspect")?.status).toBe("running")
    expect(next.tasks.find((task) => task.id === "inspect")?.last_event).toBe("inspect running")
  })

  test("extracts a fenced plan JSON block", () => {
    const plan = extractAgentClusterPlan(["Before work, here is the plan:", "```json", planJson, "```"].join("\n"))

    expect(plan?.goal).toBe("Build a detailed report")
    expect(plan?.tasks.map((task) => [task.id, task.step, task.title])).toEqual([
      ["research", 1, "Research sources"],
      ["write", 2, "Write report"],
    ])
  })

  test("removes plan JSON from cluster chat text", () => {
    const stripped = stripAgentClusterPlanText(
      ["Before work, here is the complete task plan:", "```json", planJson, "```"].join("\n"),
    )

    expect(stripped).toBe("")
  })

  test("removes Chinese plan preamble with the plan JSON", () => {
    const stripped = stripAgentClusterPlanText(
      ["在开始执行之前，我先呈现完整的任务计划：", "```json", planJson, "```"].join("\n"),
    )

    expect(stripped).toBe("")
  })

  test("repairs unescaped Windows paths in plan JSON", () => {
    const malformed = String.raw`{
  "goal": "Build a report",
  "tasks": [
    {
      "id": "pdf",
      "step": 1,
      "title": "Produce PDF",
      "role": "pdf",
      "complexity": "complex",
      "model": "mimo/mimo-v2.5",
      "dependencies": [],
      "prompt": "Write to C:\Users\35027\Desktop\new\report.pdf"
    }
  ]
}`

    const plan = extractAgentClusterPlan(["```json", malformed, "```"].join("\n"))

    expect(plan?.tasks[0]?.id).toBe("pdf")
    expect(plan?.tasks[0]?.title).toBe("Produce PDF")
    expect(stripAgentClusterPlanText(["Plan:", "```json", malformed, "```"].join("\n"))).toBe("")
  })

  test("hides partial streaming plan JSON", () => {
    const stripped = stripAgentClusterPlanText('Before work, here is the plan:\n{\n  "goal": "Build')

    expect(stripped).toBe("")
  })

  test("extracts completed tasks from partial streaming plan JSON", () => {
    const partial = [
      "Before work, here is the plan:",
      "```json",
      '{"goal":"Build a detailed report","tasks":[',
      JSON.stringify({
        id: "research",
        step: 1,
        title: "Research sources",
        role: "researcher",
        complexity: "complex",
        model: "deepseek/deepseek-v4-pro",
        dependencies: [],
        prompt: "Research the topic",
        acceptanceCriteria: ["sources collected"],
        expectedArtifacts: ["research.md"],
      }),
      ',{"id":"write","step":2,"title":"Wri',
    ].join("\n")

    const plan = extractAgentClusterPlan(partial)

    expect(plan?.partial).toBe(true)
    expect(plan?.goal).toBe("Build a detailed report")
    expect(plan?.tasks.map((task) => [task.id, task.step, task.title])).toEqual([
      ["research", 1, "Research sources"],
    ])
    expect(stripAgentClusterPlanText(partial)).toBe("")
  })

  test("merges planned steps with dispatched task status", () => {
    const parent = "ses_parent"
    const assistant = "msg_assistant"
    const task = "part_task"
    const messagesBySession: Record<string, Message[]> = {
      [parent]: [
        {
          id: assistant,
          parentID: "msg_user",
          sessionID: parent,
          role: "assistant",
          mode: "cluster",
          agent: "cluster",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "deepseek-v4-pro",
          providerID: "deepseek",
          time: { created: 1 },
        },
      ],
      ses_child: [
        {
          id: "child_assistant",
          parentID: "child_user",
          sessionID: "ses_child",
          role: "assistant",
          mode: "researcher",
          agent: "researcher",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "deepseek-v4-pro",
          providerID: "deepseek",
          finish: "stop",
          time: { created: 2, completed: 3 },
        },
      ],
    }
    const partsByMessage: Record<string, Part[]> = {
      [assistant]: [
        {
          id: "part_plan",
          sessionID: parent,
          messageID: assistant,
          type: "text",
          text: planJson,
        },
        {
          id: task,
          sessionID: parent,
          messageID: assistant,
          type: "tool",
          callID: "call_task",
          tool: "task",
          state: {
            status: "completed",
            title: "Research sources",
            input: {
              description: "Research sources",
              prompt: "Research the topic",
              subagent_type: "researcher",
              task_id: "research",
              model: "deepseek/deepseek-v4-pro",
            },
            metadata: {
              sessionId: "ses_child",
              background: true,
              model: {
                providerID: "deepseek",
                modelID: "deepseek-v4-pro",
              },
            },
            output: "task_id: ses_child\nstate: running",
            time: { start: 1, end: 2 },
          },
        },
      ],
    }

    const snapshot = agentClusterSnapshot({
      sessionID: parent,
      enabled: true,
      disabled: false,
      messages: (sessionID) => messagesBySession[sessionID] ?? [],
      parts: (messageID) => partsByMessage[messageID] ?? [],
      sessionStatus: () => ({ type: "idle" }),
    })

    expect(snapshot.totalSteps).toBe(2)
    expect(snapshot.completedSteps).toBe(1)
    expect(snapshot.currentStep).toBe(2)
    expect(snapshot.doneAgents).toBe(1)
    expect(snapshot.steps.map((step) => [step.index, step.status, step.agents])).toEqual([
      [1, "done", 1],
      [2, "queued", 1],
    ])
  })

  test("uses completed task_status tool output when child messages are not synced", () => {
    const parent = "ses_parent"
    const assistant = "msg_assistant"
    const messagesBySession: Record<string, Message[]> = {
      [parent]: [
        {
          id: assistant,
          parentID: "msg_user",
          sessionID: parent,
          role: "assistant",
          mode: "cluster",
          agent: "cluster",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "deepseek-v4-pro",
          providerID: "deepseek",
          time: { created: 1 },
        },
      ],
    }
    const partsByMessage: Record<string, Part[]> = {
      [assistant]: [
        {
          id: "part_plan",
          sessionID: parent,
          messageID: assistant,
          type: "text",
          text: planJson,
        },
        {
          id: "part_task",
          sessionID: parent,
          messageID: assistant,
          type: "tool",
          callID: "call_task",
          tool: "task",
          state: {
            status: "completed",
            title: "Research sources",
            input: {
              description: "Research sources",
              subagent_type: "researcher",
              task_id: "research",
            },
            metadata: {
              sessionId: "ses_child",
              background: true,
            },
            output: "task_id: ses_child\nstate: running",
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "part_status",
          sessionID: parent,
          messageID: assistant,
          type: "tool",
          callID: "call_status",
          tool: "task_status",
          state: {
            status: "completed",
            title: "Task status",
            input: {
              task_id: "ses_child",
              wait: true,
            },
            metadata: {},
            output: "task_id: ses_child\nstate: completed\n\n<task_result>\ndone\n</task_result>",
            time: { start: 3, end: 4 },
          },
        },
      ],
    }

    const snapshot = agentClusterSnapshot({
      sessionID: parent,
      enabled: true,
      disabled: false,
      messages: (sessionID) => messagesBySession[sessionID] ?? [],
      parts: (messageID) => partsByMessage[messageID] ?? [],
      sessionStatus: () => ({ type: "idle" }),
    })

    expect(snapshot.steps[0]?.tasks[0]?.status).toBe("done")
    expect(snapshot.completedSteps).toBe(1)
    expect(snapshot.doneAgents).toBe(1)
    expect(snapshot.currentStep).toBe(2)
  })

  test("uses injected background task result text when child messages are not synced", () => {
    const parent = "ses_parent"
    const assistant = "msg_assistant"
    const injected = "msg_injected"
    const messagesBySession: Record<string, Message[]> = {
      [parent]: [
        {
          id: assistant,
          parentID: "msg_user",
          sessionID: parent,
          role: "assistant",
          mode: "cluster",
          agent: "cluster",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "deepseek-v4-pro",
          providerID: "deepseek",
          time: { created: 1 },
        },
        {
          id: injected,
          sessionID: parent,
          role: "user",
          agent: "cluster",
          model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          time: { created: 2 },
        },
      ],
    }
    const partsByMessage: Record<string, Part[]> = {
      [assistant]: [
        {
          id: "part_plan",
          sessionID: parent,
          messageID: assistant,
          type: "text",
          text: planJson,
        },
        {
          id: "part_task",
          sessionID: parent,
          messageID: assistant,
          type: "tool",
          callID: "call_task",
          tool: "task",
          state: {
            status: "completed",
            title: "Research sources",
            input: {
              description: "Research sources",
              subagent_type: "researcher",
              task_id: "research",
            },
            metadata: {
              sessionId: "ses_child",
              background: true,
            },
            output: "task_id: ses_child\nstate: running",
            time: { start: 1, end: 2 },
          },
        },
      ],
      [injected]: [
        {
          id: "part_injected",
          sessionID: parent,
          messageID: injected,
          type: "text",
          synthetic: true,
          text: "Background task completed: Research sources\ntask_id: ses_child\nstate: completed\n\n<task_result>\ndone\n</task_result>",
        },
      ],
    }

    const snapshot = agentClusterSnapshot({
      sessionID: parent,
      enabled: true,
      disabled: false,
      messages: (sessionID) => messagesBySession[sessionID] ?? [],
      parts: (messageID) => partsByMessage[messageID] ?? [],
      sessionStatus: () => ({ type: "idle" }),
    })

    expect(snapshot.steps[0]?.tasks[0]?.status).toBe("done")
    expect(snapshot.completedSteps).toBe(1)
    expect(snapshot.doneAgents).toBe(1)
    expect(snapshot.currentStep).toBe(2)
  })

  test("snapshot uses persisted task status over title matching", () => {
    const snapshot = agentClusterSnapshot({
      sessionID: "ses_parent",
      enabled: true,
      disabled: false,
      cluster: {
        runs: [{ id: "run_1", status: "dispatching", goal: "goal" }],
        tasks: [{ id: "inspect", title: "Inspect code", status: "running", step: 1, role: "researcher" }],
      },
      messages: () => [],
      parts: () => [],
    })

    expect(snapshot.runningAgents).toBe(1)
    expect(snapshot.steps[0]?.tasks[0]?.status).toBe("running")
    expect(snapshot.plan?.tasks[0]?.skillName).toBe("cluster-research-evidence")
    expect(snapshot.plan?.tasks[0]?.skillNames).toContain("literature-review")
    expect(snapshot.plan?.tasks[0]?.capabilitySummary).toContain("sources")
    expect(snapshot.rows[0]?.skillName).toBe("cluster-research-evidence")
    expect(snapshot.rows[0]?.skillNames).toContain("research-lookup")
  })

  test("projects every cluster run in a session onto continuous steps", () => {
    const snapshot = agentClusterSnapshot({
      sessionID: "ses_parent",
      enabled: true,
      disabled: false,
      cluster: {
        runs: [
          { id: "run_2", status: "dispatching", goal: "second turn", time_created: 200 },
          { id: "run_1", status: "completed", goal: "first turn", time_created: 100 },
        ],
        tasks: [
          { id: "shared", run_id: "run_1", title: "First A", status: "accepted", step: 1, role: "coder" },
          { id: "finish", run_id: "run_1", title: "First B", status: "accepted", step: 2, role: "tester" },
          { id: "shared", run_id: "run_2", title: "Second A", status: "running", step: 1, role: "coder" },
          {
            id: "later",
            run_id: "run_2",
            title: "Second B",
            status: "planned",
            step: 3,
            role: "tester",
            dependencies: ["shared"],
          },
        ],
      },
      messages: () => [],
      parts: () => [],
    })

    expect(snapshot.steps.map((step) => [step.index, step.status])).toEqual([
      [1, "done"],
      [2, "done"],
      [3, "running"],
      [4, "queued"],
    ])
    expect(snapshot.currentStep).toBe(3)
    expect(snapshot.completedSteps).toBe(2)
    expect(new Set(snapshot.plan?.tasks.map((task) => task.id)).size).toBe(4)
    expect(snapshot.plan?.tasks.find((task) => task.title === "Second B")?.dependencies).toEqual(["run_2:shared"])
  })

  test("shows a partial plan in the snapshot while planning", () => {
    const parent = "ses_parent"
    const assistant = "msg_assistant"
    const messagesBySession: Record<string, Message[]> = {
      [parent]: [
        {
          id: assistant,
          parentID: "msg_user",
          sessionID: parent,
          role: "assistant",
          mode: "cluster",
          agent: "cluster",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "deepseek-v4-pro",
          providerID: "deepseek",
          time: { created: 1 },
        },
      ],
    }
    const partsByMessage: Record<string, Part[]> = {
      [assistant]: [
        {
          id: "part_plan",
          sessionID: parent,
          messageID: assistant,
          type: "text",
          text: [
            '{"goal":"Build a detailed report","tasks":[',
            JSON.stringify({
              id: "research",
              step: 1,
              title: "Research sources",
              role: "researcher",
              model: "deepseek/deepseek-v4-pro",
              dependencies: [],
            }),
            ',{"id":"write","step":2,"title":"Wri',
          ].join("\n"),
        },
      ],
    }

    const snapshot = agentClusterSnapshot({
      sessionID: parent,
      enabled: true,
      disabled: false,
      messages: (sessionID) => messagesBySession[sessionID] ?? [],
      parts: (messageID) => partsByMessage[messageID] ?? [],
      sessionStatus: () => ({ type: "busy" }),
    })

    expect(snapshot.status).toBe("planning")
    expect(snapshot.plan?.partial).toBe(true)
    expect(snapshot.totalSteps).toBe(1)
    expect(snapshot.currentStep).toBe(1)
    expect(snapshot.totalAgents).toBe(1)
  })

  describe("Bug fixes", () => {
    test("keeps task rows in sync with live running status", () => {
      const parent = "ses_parent"
      const assistant = "msg_assistant"
      const messagesBySession: Record<string, Message[]> = {
        [parent]: [
          {
            id: assistant,
            parentID: "msg_user",
            sessionID: parent,
            role: "assistant",
            mode: "cluster",
            agent: "cluster",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: 1 },
          },
        ],
      }
      const partsByMessage: Record<string, Part[]> = {
        [assistant]: [
          {
            id: "part_task",
            sessionID: parent,
            messageID: assistant,
            type: "tool",
            callID: "call_task",
            tool: "task",
            state: {
              status: "completed",
              title: "Create report",
              input: {
                task_id: "write",
                description: "Create report",
                prompt: "Create report",
                subagent_type: "writer",
              },
              metadata: {
                sessionId: "ses_child",
                background: true,
              },
              output: "task_id: ses_child\nstate: running",
              time: { start: 1, end: 2 },
            },
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: parent,
        enabled: true,
        disabled: false,
        cluster: {
          runs: [{ id: "run_1", status: "dispatching", goal: "Build report" }],
          tasks: [
            {
              id: "write",
              run_id: "run_1",
              child_session_id: null,
              title: "Create report",
              role: "writer",
              model: "test",
              step: 2,
              status: "planned",
              dependencies: [],
              acceptance_criteria: [],
              artifact_paths: [],
            },
          ],
        },
        messages: (sessionID) => messagesBySession[sessionID] ?? [],
        parts: (messageID) => partsByMessage[messageID] ?? [],
        sessionStatus: () => ({ type: "busy" }),
      })

      expect(snapshot.runningAgents).toBe(1)
      expect(snapshot.steps[0]?.status).toBe("running")
      expect(snapshot.rows[0]?.status).toBe("running")
      expect(snapshot.rows[0]?.sessionID).toBe("ses_child")
    })

    test("does not reuse an exact step-1 task for a later role fallback", () => {
      const parent = "ses_parent"
      const assistant = "msg_assistant"
      const task = (id: string, step: number, title: string) => ({
        id,
        step,
        title,
        role: "coder",
        complexity: "simple",
        model: "test/simple",
        dependencies: [],
        prompt: title,
        acceptanceCriteria: [],
        expectedArtifacts: [],
      })
      const livePlan = JSON.stringify({
        goal: "Build a game",
        tasks: [
          task("setup", 1, "Initialize project"),
          task("terrain", 2, "Build terrain"),
          task("player", 2, "Build player"),
          task("weather", 3, "Build weather"),
        ],
      })
      const messagesBySession: Record<string, Message[]> = {
        [parent]: [
          {
            id: assistant,
            parentID: "msg_user",
            sessionID: parent,
            role: "assistant",
            mode: "cluster",
            agent: "cluster",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: 1 },
          },
        ],
      }
      const partsByMessage: Record<string, Part[]> = {
        [assistant]: [
          {
            id: "part_plan",
            sessionID: parent,
            messageID: assistant,
            type: "text",
            text: livePlan,
          },
          {
            id: "part_task",
            sessionID: parent,
            messageID: assistant,
            type: "tool",
            callID: "call_task",
            tool: "task",
            state: {
              status: "completed",
              title: "Initialize project",
              input: {
                description: "Initialize project",
                prompt: "Initialize project",
                subagent_type: "coder",
                task_id: "setup",
              },
              metadata: {
                sessionId: "ses_child",
                background: true,
              },
              output: "task_id: ses_child\nstate: running",
              time: { start: 1, end: 2 },
            },
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: parent,
        enabled: true,
        disabled: false,
        messages: (sessionID) => messagesBySession[sessionID] ?? [],
        parts: (messageID) => partsByMessage[messageID] ?? [],
      })

      expect(snapshot.runningAgents).toBe(1)
      expect(snapshot.steps.find((step) => step.index === 1)?.status).toBe("running")
      expect(snapshot.steps.find((step) => step.index === 3)?.status).toBe("queued")
      expect(snapshot.steps.find((step) => step.index === 3)?.tasks[0]?.status).toBe("queued")
    })

    test("merges live tool-call statuses INTO authoritative cluster plan (Bug 2&3 fix)", () => {
      const parent = "ses_parent"
      const assistant = "msg_assistant"
      const cluster = {
        runs: [{ id: "run_1", status: "dispatching", goal: "Build report" }],
        tasks: [
          {
            id: "research",
            run_id: "run_1",
            title: "Research sources",
            role: "researcher" as const,
            step: 1,
            status: "submitted",
            dependencies: [],
            acceptance_criteria: [],
            artifact_paths: [],
          },
          {
            id: "write",
            run_id: "run_1",
            title: "Write report",
            role: "writer" as const,
            step: 2,
            status: "planned",
            dependencies: ["research"],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }
      const messagesBySession: Record<string, Message[]> = {
        [parent]: [
          {
            id: assistant,
            parentID: "msg_user",
            sessionID: parent,
            role: "assistant",
            mode: "cluster",
            agent: "cluster",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "deepseek-v4-pro",
            providerID: "deepseek",
            time: { created: 1 },
          },
        ],
        ses_child: [
          {
            id: "child_assistant",
            parentID: "child_user",
            sessionID: "ses_child",
            role: "assistant",
            mode: "researcher",
            agent: "researcher",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "deepseek-v4-pro",
            providerID: "deepseek",
            finish: "stop",
            time: { created: 2, completed: 3 },
          },
        ],
      }
      const partsByMessage: Record<string, Part[]> = {
        [assistant]: [
          {
            id: "part_task",
            sessionID: parent,
            messageID: assistant,
            type: "tool",
            callID: "call_task",
            tool: "task",
            state: {
              status: "completed",
              title: "Research sources",
              input: {
                description: "Research sources",
                prompt: "Research the topic",
                subagent_type: "researcher",
                task_id: "research",
                model: "deepseek/deepseek-v4-pro",
              },
              metadata: {
                sessionId: "ses_child",
                background: true,
                model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
              },
              output: "task_id: ses_child\nstate: running",
              time: { start: 1, end: 2 },
            },
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: parent,
        enabled: true,
        disabled: false,
        cluster,
        messages: (sessionID) => messagesBySession[sessionID] ?? [],
        parts: (messageID) => partsByMessage[messageID] ?? [],
        sessionStatus: () => ({ type: "idle" }),
      })

      // The authoritative plan says "submitted" and "planned", but the
      // live tool call for the child says it's done (child has completed).
      // The merged status should show step 1 as done, step 2 as queued.
      expect(snapshot.totalSteps).toBe(2)
      expect(snapshot.steps[0]?.status).toBe("done")
      expect(snapshot.steps[1]?.status).toBe("queued")
      expect(snapshot.completedSteps).toBe(1)
      expect(snapshot.doneAgents).toBe(1)
      expect(snapshot.currentStep).toBe(2)
      // Verify that each step has the correct tasks
      expect(snapshot.steps[0]?.tasks.map((t) => t.id)).toEqual(["research"])
      expect(snapshot.steps[1]?.tasks.map((t) => t.id)).toEqual(["write"])
    })

    test("multi-step plan tasks remain in correct steps after status merge (Bug 3 fix)", () => {
      const cluster = {
        runs: [{ id: "run_1", status: "dispatching", goal: "Multi-step plan" }],
        tasks: [
          {
            id: "t1",
            run_id: "run_1",
            title: "Step 1 task A",
            role: "researcher" as const,
            step: 1,
            status: "accepted",
            dependencies: [] as string[],
            acceptance_criteria: [],
            artifact_paths: [],
          },
          {
            id: "t2",
            run_id: "run_1",
            title: "Step 1 task B",
            role: "coder" as const,
            step: 1,
            status: "accepted",
            dependencies: [] as string[],
            acceptance_criteria: [],
            artifact_paths: [],
          },
          {
            id: "t3",
            run_id: "run_1",
            title: "Step 2 task C",
            role: "writer" as const,
            step: 2,
            status: "running",
            dependencies: ["t1"],
            acceptance_criteria: [],
            artifact_paths: [],
          },
          {
            id: "t4",
            run_id: "run_1",
            title: "Step 3 task D",
            role: "tester" as const,
            step: 3,
            status: "planned",
            dependencies: ["t3"],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: "ses_parent",
        enabled: true,
        disabled: false,
        cluster,
        messages: () => [],
        parts: () => [],
      })

      // Each task must stay in its own step
      expect(snapshot.totalSteps).toBe(3)
      expect(snapshot.steps[0]?.tasks.map((t) => t.id)).toEqual(["t1", "t2"])
      expect(snapshot.steps[0]?.status).toBe("done")
      expect(snapshot.steps[1]?.tasks.map((t) => t.id)).toEqual(["t3"])
      expect(snapshot.steps[1]?.status).toBe("running")
      expect(snapshot.steps[2]?.tasks.map((t) => t.id)).toEqual(["t4"])
      expect(snapshot.steps[2]?.status).toBe("queued")
      expect(snapshot.currentStep).toBe(2)
      expect(snapshot.completedSteps).toBe(1)
      expect(snapshot.runningAgents).toBe(1)
    })

    test("authoritative cluster plan preserves dependencies from DB (Bug 3 fix)", () => {
      const cluster = {
        runs: [{ id: "run_1", status: "dispatching", goal: "Plan with deps" }],
        tasks: [
          {
            id: "base",
            run_id: "run_1",
            title: "Base research",
            role: "researcher" as const,
            step: 1,
            status: "accepted",
            dependencies: [] as string[],
            acceptance_criteria: [],
            artifact_paths: [],
          },
          {
            id: "build",
            run_id: "run_1",
            title: "Build on research",
            role: "coder" as const,
            step: 2,
            status: "planned",
            dependencies: ["base"],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: "ses_parent",
        enabled: true,
        disabled: false,
        cluster,
        messages: () => [],
        parts: () => [],
      })

      // Verify dependencies are preserved from DB
      expect(snapshot.plan?.tasks.find((t) => t.id === "build")?.dependencies).toEqual(["base"])
      expect(snapshot.plan?.tasks.find((t) => t.id === "base")?.dependencies).toEqual([])
      // Verify steps are correct
      expect(snapshot.steps[0]?.tasks[0]?.id).toBe("base")
      expect(snapshot.steps[1]?.tasks[0]?.id).toBe("build")
    })

    test("revision_requested task shows as running in snapshot", () => {
      const cluster = {
        runs: [{ id: "run_1", status: "reviewing", goal: "Revision test" }],
        tasks: [
          {
            id: "revise-me",
            run_id: "run_1",
            title: "Needs revision",
            role: "coder" as const,
            step: 1,
            status: "revision_requested",
            child_session_id: "ses_child",
            dependencies: [] as string[],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: "ses_parent",
        enabled: true,
        disabled: false,
        cluster,
        messages: () => [],
        parts: () => [],
      })

      // revision_requested status should map to "running"
      expect(snapshot.steps[0]?.tasks[0]?.status).toBe("running")
      expect(snapshot.runningAgents).toBe(1)
      expect(snapshot.status).toBe("dispatching")
    })

    test("revising task shows as running in snapshot", () => {
      const cluster = {
        runs: [{ id: "run_1", status: "reviewing", goal: "Revising test" }],
        tasks: [
          {
            id: "in-revision",
            run_id: "run_1",
            title: "Currently revising",
            role: "coder" as const,
            step: 1,
            status: "revising",
            child_session_id: "ses_child",
            dependencies: [] as string[],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }

      const snapshot = agentClusterSnapshot({
        sessionID: "ses_parent",
        enabled: true,
        disabled: false,
        cluster,
        messages: () => [],
        parts: () => [],
      })

      expect(snapshot.steps[0]?.tasks[0]?.status).toBe("running")
      expect(snapshot.runningAgents).toBe(1)
    })

    test("dispatch preflight errors do not mark persisted planned tasks as failed", () => {
      const cluster = {
        runs: [{ id: "run_current", status: "dispatching", goal: "Reuse a prior worker" }],
        tasks: [
          {
            id: "follow-up",
            run_id: "run_current",
            title: "Return work to prior agent",
            role: "general" as const,
            step: 2,
            status: "planned",
            dependencies: ["prepare"],
            acceptance_criteria: [],
            artifact_paths: [],
          },
        ],
      }
      const assistant = "msg_assistant"
      const snapshot = agentClusterSnapshot({
        sessionID: "ses_parent",
        enabled: true,
        disabled: false,
        cluster,
        messages: () =>
          [
            {
              id: assistant,
              sessionID: "ses_parent",
              role: "assistant",
              time: { created: 1 },
            },
          ] as Message[],
        parts: (messageID) =>
          messageID === assistant
            ? ([
                {
                  id: "part_task",
                  messageID: assistant,
                  sessionID: "ses_parent",
                  type: "tool",
                  callID: "call_task",
                  tool: "task",
                  state: {
                    status: "error",
                    input: {
                      description: "Return work to prior agent",
                      prompt: "Continue the work",
                      subagent_type: "general",
                      task_id: "follow-up",
                      resume_session_id: "ses_old_child",
                    },
                    error: "Step gate blocked",
                    time: { start: 1, end: 2 },
                  },
                },
              ] as Part[])
            : [],
      })

      expect(snapshot.steps[0]?.tasks[0]?.status).toBe("queued")
      expect(snapshot.rows[0]?.status).toBe("queued")
      expect(snapshot.failedAgents).toBe(0)
    })
  })
})
