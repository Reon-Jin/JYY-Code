import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const composerCSS = readFileSync("src/features/composer/composer.css", "utf8")
const sessionsCSS = readFileSync("src/features/sessions/sessions.css", "utf8")
const conversationCSS = readFileSync("src/features/conversation/conversation.css", "utf8")
const fileEditorCSS = readFileSync("src/features/files/file-editor.css", "utf8")
const filePreviewCSS = readFileSync("src/features/files/file-preview.css", "utf8")
const multiAgentCSS = readFileSync("src/features/multi-agent/multi-agent.css", "utf8")

describe("conversation layout CSS", () => {
  it("caps the workspace and reserves a scrollable timeline above the Composer", () => {
    expect(sessionsCSS).toMatch(/\.workspace-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s)
    expect(sessionsCSS).toMatch(/\.workspace-shell\s*\{[^}]*--workspace-header-height:\s*69px;/s)
    expect(sessionsCSS).toMatch(/\.workspace-project\s*\{[^}]*height:\s*var\(--workspace-header-height\);/s)
    expect(sessionsCSS).toMatch(
      /\.workspace-conversation__header\s*\{[^}]*height:\s*var\(--workspace-header-height\);[^}]*align-content:\s*center;/s,
    )
    expect(composerCSS).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/)
    expect(conversationCSS).toMatch(/\.message-timeline__viewport\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s)
  })

  it("uses the responsive wide-screen content width for the timeline and Composer", () => {
    expect(sessionsCSS).toMatch(/--conversation-content-width:\s*min\(1100px, calc\(100% - 32px\)\);/)
    expect(conversationCSS).toMatch(/\.message-timeline\s*\{[^}]*width:\s*100%;/s)
    expect(conversationCSS).toMatch(
      /\.message-timeline__content\s*\{[^}]*width:\s*var\(--conversation-content-width\);[^}]*margin:\s*0 auto;/s,
    )
    expect(composerCSS).toMatch(/\.composer-stack\s*\{[^}]*width:\s*var\(--conversation-content-width\);/s)
    expect(composerCSS).toMatch(/\.provider-empty\s*\{[^}]*width:\s*var\(--conversation-content-width\);/s)
    expect(`${conversationCSS}\n${composerCSS}`).not.toContain("820px")
  })

  it("aligns file editor and preview headers with the conversation header", () => {
    expect(fileEditorCSS).toMatch(
      /\.file-editor__header\s*\{[^}]*height:\s*var\(--workspace-header-height,\s*69px\);[^}]*min-height:\s*var\(--workspace-header-height,\s*69px\);/s,
    )
    expect(filePreviewCSS).toMatch(
      /\.file-preview__header\s*\{[^}]*height:\s*var\(--workspace-header-height,\s*69px\);[^}]*min-height:\s*var\(--workspace-header-height,\s*69px\);/s,
    )
  })

  it("keeps PDF translation in a compact bottom drawer instead of a fixed sidebar", () => {
    expect(filePreviewCSS).toMatch(
      /\.file-preview__pdf-workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s,
    )
    expect(filePreviewCSS).not.toMatch(
      /\.file-preview__pdf-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(190px, 260px\);/s,
    )
    expect(filePreviewCSS).toMatch(/\.file-preview__pdf-translation\s*\{[^}]*max-height:\s*clamp\(/s)
    expect(filePreviewCSS).toMatch(
      /\.file-preview__pdf-translation-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.2fr\);/s,
    )
  })

  it("points activity chevrons down while expanded and up while collapsed", () => {
    expect(conversationCSS).toMatch(/\.reasoning-part__toggle svg:last-child\s*\{[^}]*transform:\s*rotate\(180deg\);/s)
    expect(conversationCSS).toMatch(/\.reasoning-part__toggle svg\[data-expanded="true"\]\s*\{[^}]*transform:\s*none;/s)
    expect(conversationCSS).toMatch(/\.activity-group__toggle svg:last-child\s*\{[^}]*transform:\s*rotate\(180deg\);/s)
    expect(conversationCSS).toMatch(/\.activity-group__toggle svg\[data-expanded="true"\]\s*\{[^}]*transform:\s*none;/s)
  })

  it("uses compact inline metrics and keeps Multi-Agent motion on active work", () => {
    expect(composerCSS).toMatch(/\.composer-select\s*\{[^}]*width:\s*100px;[^}]*min-width:\s*100px;/s)
    expect(composerCSS).toMatch(/\.composer-usage__item\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s)
    expect(multiAgentCSS).toMatch(
      /\.multi-agent-step\[data-tone="running"\] \.multi-agent-step__marker,[^{]*\{[^}]*animation:/s,
    )
    expect(multiAgentCSS).not.toContain("multi-agent-activation-wave")
  })

  it("aligns the user bubble and Agent content on opposite sides and keeps tool calls compact", () => {
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*justify-self:\s*end;[^}]*text-align:\s*left;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\] \.conversation-message__parts\s*\{[^}]*justify-items:\s*stretch;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*50%;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*background:\s*var\(--color-accent-muted\);/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="assistant"\]\s*\{[^}]*width:\s*100%;[^}]*justify-self:\s*start;/s,
    )
    expect(conversationCSS).toMatch(
      /\.tool-call\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) auto;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="assistant"\]\s*\+\s*\.conversation-message\[data-role="assistant"\]\s*\{[^}]*margin-top:\s*calc\(-1 \* var\(--space-6\)\);/s,
    )
    expect(conversationCSS).toMatch(
      /\.reasoning-part__toggle\s*\{[^}]*gap:\s*6px;[^}]*margin-inline:\s*var\(--space-1\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*padding:\s*2px var\(--space-2\);/s,
    )
    expect(conversationCSS).toMatch(
      /\.activity-group__toggle\s*\{[^}]*gap:\s*6px;[^}]*margin-inline:\s*var\(--space-1\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*padding:\s*2px var\(--space-2\);/s,
    )
    expect(conversationCSS).toMatch(/\.tool-call\s*\{[^}]*padding:\s*0;/s)
    expect(conversationCSS).not.toContain(".tool-call__details")
  })
})
