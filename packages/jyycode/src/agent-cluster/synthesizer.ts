export * as AgentClusterSynthesizer from "./synthesizer"

export const SynthesisInstructions = [
  "Synthesize only after task review is complete.",
  "Use accepted artifacts as the source of truth.",
  "Final output should include the direct answer or final artifact path, a compact summary of completed work, and explicit unresolved risks for failed or degraded tasks.",
  "Do not paste large artifacts into the final message when a file path is available.",
].join("\n")

export function buildSynthesisPrompt(input: {
  goal: string
  acceptedTasks: { title: string; summary: string; artifacts: readonly string[] }[]
  failedTasks: { title: string; reason: string }[]
  cancelledTasks: { title: string }[]
}): string {
  const sections: string[] = [
    "## Synthesis",
    `Goal: ${input.goal}`,
    "",
  ]

  if (input.acceptedTasks.length > 0) {
    sections.push("### Accepted Tasks")
    for (const task of input.acceptedTasks) {
      sections.push(`- **${task.title}**: ${task.summary}`)
      if (task.artifacts.length > 0) {
        sections.push(`  Artifacts: ${task.artifacts.join(", ")}`)
      }
    }
    sections.push("")
  }

  if (input.failedTasks.length > 0) {
    sections.push("### Failed Tasks (Unresolved Risks)")
    for (const task of input.failedTasks) {
      sections.push(`- **${task.title}**: ${task.reason}`)
    }
    sections.push("")
  }

  if (input.cancelledTasks.length > 0) {
    sections.push("### Cancelled Tasks")
    for (const task of input.cancelledTasks) {
      sections.push(`- **${task.title}**`)
    }
    sections.push("")
  }

  return sections.join("\n")
}
