import { describe, expect, it, vi } from "vitest"
import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import { loadPlan } from "./plan-query"

describe("loadPlan", () => {
  it("loads the new file-backed plan snapshot endpoint", async () => {
    const state: SessionPlanResponse = { plan: null }
    const plan = vi.fn().mockResolvedValue({ data: state })
    const client = { session: { plan } } as never
    const directory = "C:\\work"
    await expect(loadPlan({ client, directory, sessionID: "ses_root" })).resolves.toEqual(state)
    expect(plan).toHaveBeenCalledWith({ directory, sessionID: "ses_root" }, { throwOnError: true })
  })
})
