import type { StepFinishPart, StepStartPart } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { MessagePartView } from "./message-part"

const base = { id: "part_step", sessionID: "ses_1", messageID: "msg_1" }

afterEach(cleanup)

describe("MessagePartView", () => {
  it("does not expose structural step markers as unsupported content", () => {
    const start: StepStartPart = { ...base, type: "step-start" }
    const finish: StepFinishPart = {
      ...base,
      id: "part_finish",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    render(() => (
      <>
        <MessagePartView part={start} />
        <MessagePartView part={finish} />
      </>
    ))

    expect(screen.queryByText(/Unsupported content/)).not.toBeInTheDocument()
  })
})
