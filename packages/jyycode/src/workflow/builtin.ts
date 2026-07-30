import { ulid } from "ulid"
import type { ExecutionMode, RunPlan, RunPlanTask, Workflow } from "./schema"
import { NodeID, RunPlanID } from "./schema"
import type { SessionID } from "@/session/schema"

const validatedResult = {
  id: "validated-result",
  title: "\u5df2\u4ea7\u51fa\u660e\u786e\u7ed3\u679c\uff0c\u5e76\u5728\u9a8c\u6536\u524d\u5b8c\u6210\u9a8c\u8bc1\u3002",
  required: true,
}

export const GeneralWorkflow: Workflow = {
  id: "general" as Workflow["id"],
  version: "2.0.0" as Workflow["version"],
  displayName: "\u901a\u7528\u5de5\u4f5c\u6d41",
  supports: { single: true, multi: true },
  stages: [
    {
      id: "implementation" as any,
      title: "\u6267\u884c\u4efb\u52a1",
      dependsOn: [],
      steps: [
        {
          id: "execute" as any,
          title: "\u6267\u884c\u5e76\u9a8c\u8bc1",
          dependsOn: [],
          tasks: [
            {
              id: "execute" as any,
              title: "\u5b8c\u6210\u7528\u6237\u8bf7\u6c42\u5e76\u9a8c\u8bc1\u7ed3\u679c",
              dependsOn: [],
              acceptance: [validatedResult],
            },
          ],
        },
      ],
    },
  ],
}

export const WorkflowCreationWorkflow: Workflow = {
  id: "workflow-creation" as Workflow["id"],
  version: "2.0.0" as Workflow["version"],
  displayName: "\u521b\u5efa\u5de5\u4f5c\u6d41",
  supports: { single: true, multi: true },
  stages: [
    {
      id: "workflow-discovery" as any,
      title: "\u68b3\u7406\u9700\u6c42",
      dependsOn: [],
      steps: [
        {
          id: "workflow-interview" as any,
          title: "\u786e\u8ba4\u5de5\u4f5c\u6d41\u76ee\u6807\u4e0e\u8fb9\u754c",
          dependsOn: [],
          tasks: [
            {
              id: "workflow-interview" as any,
              title: "\u6f84\u6e05\u76ee\u6807\u3001\u8f93\u5165\u3001\u4ea4\u4ed8\u7269\u548c\u7ea6\u675f",
              dependsOn: [],
              acceptance: [{ id: "workflow-requirements", title: "\u5de5\u4f5c\u6d41\u9700\u6c42\u3001\u8fb9\u754c\u548c\u5173\u952e\u7ea6\u675f\u5df2\u7ecf\u786e\u8ba4\u3002", required: true }],
            },
            {
              id: "workflow-specification" as any,
              title: "\u7f16\u5199\u9636\u6bb5\u3001\u4f9d\u8d56\u3001\u9a8c\u6536\u6807\u51c6\u4e0e\u6267\u884c\u7b56\u7565",
              dependsOn: ["workflow-interview" as any],
              acceptance: [{ id: "workflow-schema", title: "\u5de5\u4f5c\u6d41\u5b9a\u4e49\u901a\u8fc7\u7ed3\u6784\u548c\u4f9d\u8d56\u6821\u9a8c\u3002", required: true }],
            },
            {
              id: "workflow-validation" as any,
              title: "\u6a21\u62df\u5355\u667a\u80fd\u4f53\u4e0e\u591a\u667a\u80fd\u4f53\u6267\u884c\u5e76\u51c6\u5907\u5b89\u88c5",
              dependsOn: ["workflow-specification" as any],
              acceptance: [{ id: "workflow-validation", title: "\u6a21\u62df\u3001\u6700\u5c0f\u8bd5\u8fd0\u884c\u548c\u5b89\u88c5\u8bf4\u660e\u5747\u5df2\u51c6\u5907\u3002", required: true }],
            },
          ],
        },
      ],
    },
  ],
}

export const BuiltinWorkflows = [GeneralWorkflow, WorkflowCreationWorkflow] as const

export function createRunPlanForWorkflow(input: {
  sessionID: SessionID
  goal: string
  mode: ExecutionMode
  workflow: Workflow
  id?: RunPlan["id"]
  version?: number
}): RunPlan {
  const now = Date.now()
  return {
    id: input.id ?? RunPlanID.make(ulid()),
    sessionID: input.sessionID,
    workflowID: input.workflow.id,
    workflowVersion: input.workflow.version,
    version: input.version ?? 1,
    mode: input.mode,
    goal: input.goal,
    tasks: input.workflow.stages.flatMap((stage) =>
      stage.steps.flatMap((step) =>
        step.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          stageID: stage.id,
          stepID: step.id,
          dependsOn: task.dependsOn,
          status: "planned" as const,
          acceptance: task.acceptance,
        })),
      ),
    ),
    createdAt: now,
    updatedAt: now,
  }
}

export function createGeneralRunPlan(input: { sessionID: SessionID; goal: string; mode: ExecutionMode }): RunPlan {
  return createRunPlanForWorkflow({ ...input, workflow: GeneralWorkflow })
}

export function createFollowUpTask(title: string, dependsOn: readonly RunPlanTask["id"][]): RunPlanTask {
  return {
    id: NodeID.make(`follow-up-${ulid()}`),
    title,
    stageID: "implementation" as any,
    stepID: "execute" as any,
    dependsOn,
    status: "planned",
    acceptance: [validatedResult],
  }
}
