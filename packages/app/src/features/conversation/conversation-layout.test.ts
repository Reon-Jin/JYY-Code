import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const composerCSS = readFileSync("src/features/composer/composer.css", "utf8")
const sessionsCSS = readFileSync("src/features/sessions/sessions.css", "utf8")
const conversationCSS = readFileSync("src/features/conversation/conversation.css", "utf8")
const multiAgentCSS = readFileSync("src/features/multi-agent/multi-agent.css", "utf8")
const workbenchCSS = readFileSync("src/features/session-workspace/session-workspace.css", "utf8")
const tokensCSS = readFileSync("src/styles/tokens.css", "utf8")

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

  it("points activity chevrons down while expanded and up while collapsed", () => {
    expect(conversationCSS).toMatch(/\.reasoning-part__toggle svg:last-child\s*\{[^}]*transform:\s*rotate\(180deg\);/s)
    expect(conversationCSS).toMatch(/\.reasoning-part__toggle svg\[data-expanded="true"\]\s*\{[^}]*transform:\s*none;/s)
    expect(conversationCSS).toMatch(/\.activity-group__toggle svg:last-child\s*\{[^}]*transform:\s*rotate\(180deg\);/s)
    expect(conversationCSS).toMatch(/\.activity-group__toggle svg\[data-expanded="true"\]\s*\{[^}]*transform:\s*none;/s)
  })

  it("uses compact inline metrics and keeps Multi-Agent motion on active work", () => {
    expect(composerCSS).toMatch(/\.composer-select\s*\{[^}]*width:\s*80px;[^}]*min-width:\s*80px;/s)
    expect(composerCSS).toMatch(/\.composer-usage__item\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s)
    expect(multiAgentCSS).toMatch(/\.cluster-model-control__button\s*\{[^}]*min-width:\s*360px;/s)
    expect(workbenchCSS).toMatch(
      /\.agent-flow__nodes button\[data-status="running"\] \.agent-flow__pulse\s*\{[^}]*animation:\s*agent-node-pulse/s,
    )
    expect(workbenchCSS).toMatch(/\.agent-flow__network i\s*\{[^}]*animation:\s*agent-flow-signal/s)
    expect(workbenchCSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })

  it("aligns the user bubble and Agent content on opposite sides and keeps tool calls compact", () => {
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*justify-self:\s*end;[^}]*text-align:\s*left;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\] \.conversation-message__parts\s*\{[^}]*justify-items:\s*stretch;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*82%;/s,
    )
    expect(conversationCSS).toMatch(
      /\.conversation-message\[data-role="user"\]\s*\{[^}]*background:\s*var\(--color-surface\);/s,
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

  it("keeps generous spacing around the chat header and workbench cards", () => {
    expect(tokensCSS).toMatch(/--space-5:\s*20px;/)
    expect(workbenchCSS).toMatch(
      /\.session-workbench__chat > header\s*\{[^}]*padding:\s*var\(--space-5\) var\(--space-6\);/s,
    )
    expect(workbenchCSS).toMatch(/\.workbench-board\s*\{[^}]*margin-bottom:\s*var\(--space-4\);/s)
  })

  it("keeps one compact task toolbar in the top header", () => {
    expect(workbenchCSS).toMatch(
      /\.session-workbench__command-bar \.composer--toolbar\s*\{[^}]*margin:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
    )
    expect(workbenchCSS).toMatch(
      /\.session-workbench__canvas\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s,
    )
    expect(workbenchCSS).not.toContain(".session-workbench__control-shelf")
  })
})
