import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const composerCSS = readFileSync("src/features/composer/composer.css", "utf8")
const sessionsCSS = readFileSync("src/features/sessions/sessions.css", "utf8")
const conversationCSS = readFileSync("src/features/conversation/conversation.css", "utf8")

describe("conversation layout CSS", () => {
  it("caps the workspace and reserves a scrollable timeline above the Composer", () => {
    expect(sessionsCSS).toMatch(/\.workspace-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s)
    expect(composerCSS).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/)
    expect(conversationCSS).toMatch(/\.message-timeline__viewport\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s)
  })

  it("uses the responsive wide-screen content width for the timeline and Composer", () => {
    expect(sessionsCSS).toMatch(
      /--conversation-content-width:\s*min\(1280px, calc\(100% - 32px\)\);/,
    )
    expect(conversationCSS).toMatch(/\.message-timeline\s*\{[^}]*width:\s*100%;/s)
    expect(conversationCSS).toMatch(
      /\.message-timeline__content\s*\{[^}]*width:\s*var\(--conversation-content-width\);[^}]*margin:\s*0 auto;/s,
    )
    expect(composerCSS).toMatch(/\.composer\s*\{[^}]*width:\s*var\(--conversation-content-width\);/s)
    expect(composerCSS).toMatch(/\.provider-empty\s*\{[^}]*width:\s*var\(--conversation-content-width\);/s)
    expect(`${conversationCSS}\n${composerCSS}`).not.toContain("820px")
  })
})
