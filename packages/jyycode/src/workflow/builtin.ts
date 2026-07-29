import { ulid } from "ulid"
import type { ExecutionMode, RunPlan, RunPlanTask, Workflow } from "./schema"
import { NodeID, RunPlanID } from "./schema"
import type { SessionID } from "@/session/schema"

export const GeneralWorkflow: Workflow = {
  id: "general" as Workflow["id"],
  version: "2.0.0" as Workflow["version"],
  displayName: "General engineering",
  supports: { single: true, multi: true },
  stages: [
    {
      id: "implementation" as any,
      title: "Implementation",
      dependsOn: [],
      steps: [
        {
          id: "execute" as any,
          title: "Execute and validate",
          dependsOn: [],
          tasks: [
            {
              id: "execute" as any,
              title: "Complete the requested work",
              dependsOn: [],
              acceptance: [
                { id: "validated-result", title: "A concrete result is produced and validated before acceptance.", required: true },
              ],
            },
          ],
        },
      ],
    },
  ],
}

export function createGeneralRunPlan(input: { sessionID: SessionID; goal: string; mode: ExecutionMode }): RunPlan {
  const now = Date.now()
  return {
    id: RunPlanID.make(ulid()),
    sessionID: input.sessionID,
    workflowID: GeneralWorkflow.id,
    workflowVersion: GeneralWorkflow.version,
    version: 1,
    mode: input.mode,
    goal: input.goal,
    tasks: [
      {
        id: NodeID.make("execute"),
        title: "Complete the requested work",
        stageID: "implementation" as any,
        stepID: "execute" as any,
        dependsOn: [],
        status: "planned",
        acceptance: [
          { id: "validated-result", title: "A concrete result is produced and validated before acceptance.", required: true },
        ],
      },
    ],
    createdAt: now,
    updatedAt: now,
  }
}

export function createFollowUpTask(title: string, dependsOn: readonly RunPlanTask["id"][]): RunPlanTask {
  return {
    id: NodeID.make(`follow-up-${ulid()}`),
    title,
    stageID: "implementation" as any,
    stepID: "execute" as any,
    dependsOn,
    status: "planned",
    acceptance: [
      { id: "validated-result", title: "A concrete result is produced and validated before acceptance.", required: true },
    ],
  }
}
