export const ReviewInstructions = [
  "Review each subagent result as the cluster primary.",
  "The review must compare submitted artifacts and summaries against the task acceptance criteria.",
  "Return a structured decision: accepted, revision_requested, or failed.",
  "For revision_requested, include concrete issues and a revision prompt that can be sent back to the same subagent with the same task_id.",
  "Do not accept missing artifacts, missing citations, unverified claims, or outputs that ignore explicit user constraints unless you clearly mark a risk and explain the degradation.",
].join("\n")
