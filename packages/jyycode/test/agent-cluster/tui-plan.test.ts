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
  test("agent_cluster.event updates task status by task id", () => {
    const initial: AgentClusterState = {
      runs: [
        {
          id: "run_1",
          session_id: "ses_parent",
          parent_message_id: "msg_user",
          enabled: true,
          status: "dispatching",
          goal: "goal",
          planner_model: "test/planner",
          reviewer_model: "test/reviewer",
          time_created: 1,
          time_updated: 1,
          completed_at: null,
        },
      ],
      tasks: [
        {
          id: "inspect",
          run_id: "run_1",
          parent_task_id: null,
          child_session_id: null,
          role: "researcher",
          title: "Inspect code",
          prompt: "Inspect code",
          complexity: "simple",
          model: "test/simple",
          status: "planned",
          review_round: 0,
          acceptance_criteria: [],
          artifact_paths: [],
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
        runID: "run_1",
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
})
