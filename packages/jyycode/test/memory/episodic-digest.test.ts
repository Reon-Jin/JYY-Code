import { describe, expect, it } from "bun:test"
import { buildDigestPrompt, formatEpisodesForDigest } from "@/memory/episodic-digest"

const episode = {
  version: 1 as const,
  sessionID: "ses_test",
  turn: 1,
  time: "2026-08-07T00:00:00Z",
  userText: "查一下北京天气",
  files: [],
  toolCalls: [
    {
      tool: "web_fetch",
      input: '{"url":"https://example.com/weather"}',
      output: "北京 晴 32°C 湿度40%",
    },
  ],
  assistantText: "北京今天晴，32 度。",
}

describe("episodic digest prompt", () => {
  it("includes previous digest, backfill, and episodes", () => {
    const prompt = buildDigestPrompt({
      previousDigest: "旧摘要",
      backfillText: "旧历史",
      episodes: [episode],
    })
    expect(prompt).toContain("<previous-digest>")
    expect(prompt).toContain("<older-history>")
    expect(prompt).toContain("<new-episodes>")
    expect(prompt).toContain("web_fetch")
  })

  it("formats episodes with bounded tool outputs", () => {
    const text = formatEpisodesForDigest([episode])
    expect(text).toContain("北京 晴 32°C")
    expect(text).toContain("Turn 1")
  })
})
