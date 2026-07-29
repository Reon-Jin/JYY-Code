export * as WorkflowStateMachine from "./state-machine"

import type { NodeStatus } from "./schema"

const transitions: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  planned: ["ready"],
  ready: ["running"],
  running: ["submitted", "interrupted", "checkpointing", "failed"],
  submitted: ["reviewing"],
  reviewing: ["accepted", "revision_requested"],
  revision_requested: ["revising"],
  revising: ["submitted", "failed"],
  interrupted: ["needs_validation"],
  needs_validation: ["reassigned", "failed"],
  checkpointing: ["checkpointed"],
  checkpointed: ["reassigned"],
  reassigned: ["running"],
  failed: ["replan_requested", "failed_with_report"],
  replan_requested: ["planned"],
  accepted: [],
  blocked: [],
  failed_with_report: [],
}

export function canTransition(from: NodeStatus, to: NodeStatus) {
  return transitions[from].includes(to)
}

export function assertTransition(from: NodeStatus, to: NodeStatus) {
  if (!canTransition(from, to)) throw new Error(`Invalid workflow state transition: ${from} -> ${to}`)
}

export function allowedTransitions(status: NodeStatus) {
  return transitions[status]
}
