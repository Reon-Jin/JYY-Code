// @ts-nocheck
import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import { loadAgentCluster } from "./multi-agent-query"

describe("multi-agent query", () => {
  it("loads the authoritative cluster snapshot through the generated SDK", async () => {
    const directory = "C:\\work\\demo"
    const state: SessionAgentClusterResponse = { runs: [], tasks: [] }
    const agentCluster = vi.fn().mockResolvedValue({ data: state })
    const client = { session: { agentCluster } } as never

    await expect(loadAgentCluster({ client, directory, sessionID: "ses_root" })).resolves.toEqual(state)

    expect(agentCluster).toHaveBeenCalledWith(
      { directory, sessionID: "ses_root" },
      { throwOnError: true },
    )
  })
})
// @ts-nocheck
