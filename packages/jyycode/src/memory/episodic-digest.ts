import type { EpisodeTurn } from "./episodic"

export const DIGEST_PROMPT_TOOL_OUTPUT_MAX = 2_000
export const DIGEST_PROMPT_TEXT_MAX = 1_500
export const DIGEST_MAX_OUTPUT_CHARS = 3_000

export function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…(truncated ${text.length - maxChars} chars)`
}

export function formatEpisodeForDigest(episode: EpisodeTurn) {
  const lines = [`Turn ${episode.turn} (${episode.time})`]
  if (episode.userText) lines.push(`User: ${truncate(episode.userText, 1_000)}`)
  if (episode.files.length) lines.push(`Files: ${episode.files.join(", ")}`)
  for (const call of episode.toolCalls) {
    lines.push(`Tool ${call.tool}: input=${truncate(call.input, 800)}`)
    if (call.error) lines.push(`  error=${truncate(call.error, DIGEST_PROMPT_TOOL_OUTPUT_MAX)}`)
    else if (call.output) lines.push(`  result=${truncate(call.output, DIGEST_PROMPT_TOOL_OUTPUT_MAX)}`)
  }
  if (episode.assistantText) lines.push(`Assistant: ${truncate(episode.assistantText, DIGEST_PROMPT_TEXT_MAX)}`)
  return lines.join("\n")
}

export function formatEpisodesForDigest(episodes: EpisodeTurn[]) {
  return episodes.map(formatEpisodeForDigest).join("\n\n---\n\n")
}

export function buildDigestPrompt(input: { previousDigest?: string; backfillText?: string; episodes: EpisodeTurn[] }) {
  const lines = [
    "You are the episodic memory compactor for a coding assistant.",
    "Compress completed conversation turns into a cumulative Markdown digest that preserves what still matters for future turns.",
    "",
    "Always follow this exact structure:",
    "## 目标与约束",
    "## 已完成事项与关键结果",
    "## 决策与理由",
    "## 遇到的问题与解决方案",
    "## 待办与下一步",
    "## 重要事实（精确路径、命令、错误信息、数字）",
    "",
    "Rules:",
    "- Keep exact file paths, commands, identifiers, error messages, and decisions.",
    "- From tool results keep only key facts; drop web-page boilerplate, long listings, and raw dumps.",
    "- Discard superseded details; when a previous digest is given, carry forward only what is still true and merge new facts into it.",
    "- Do not mention the compaction process. Respond in the same language as the conversation.",
    `- Output at most ${DIGEST_MAX_OUTPUT_CHARS} characters.`,
  ]
  if (input.previousDigest) lines.push("", "<previous-digest>", input.previousDigest, "</previous-digest>")
  if (input.backfillText) lines.push("", "<older-history>", input.backfillText, "</older-history>")
  if (input.episodes.length) {
    lines.push("", "<new-episodes>", formatEpisodesForDigest(input.episodes), "</new-episodes>")
  }
  lines.push("", "Output the cumulative digest now.")
  return lines.join("\n")
}
