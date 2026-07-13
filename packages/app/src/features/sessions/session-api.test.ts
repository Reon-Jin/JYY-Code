import type { Session } from "@jyycode-ai/sdk/v2/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopClient } from "../../data/sdk"
import { createSessionApi } from "./session-api"

const directory = "C:\\work\\demo"
const model: NonNullable<Session["model"]> = {
  id: "gpt-5",
  providerID: "openai",
}
const session = {
  id: "ses_1",
  slug: "new-session",
  projectID: "project_1",
  directory,
  title: "New session",
  version: "test",
  time: { created: 1, updated: 1 },
} satisfies Session

function createHarness() {
  const client = {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
      create: vi.fn(async () => ({ data: session })),
      update: vi.fn(async () => ({ data: undefined })),
      delete: vi.fn(async () => ({ data: true })),
    },
  } as unknown as DesktopClient

  return { client, api: createSessionApi({ client, directory }) }
}

describe("session api", () => {
  beforeEach(() => vi.clearAllMocks())

  it("lists only current-project root sessions", async () => {
    const { api, client } = createHarness()

    await api.list(false)

    expect(client.session.list).toHaveBeenCalledWith(
      { directory, scope: "project", roots: true },
      { throwOnError: true },
    )
  })

  it("forces single-Agent mode when creating a session", async () => {
    const { api, client } = createHarness()

    await api.create({ title: "New session", agent: "build", model })

    expect(client.session.create).toHaveBeenCalledWith(
      { directory, title: "New session", agent: "build", model, multiAgent: false },
      { throwOnError: true },
    )
  })

  it("archives through session.update", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1234)
    const { api, client } = createHarness()

    await api.archive("ses_1")

    expect(client.session.update).toHaveBeenCalledWith(
      { directory, sessionID: "ses_1", time: { archived: 1234 } },
      { throwOnError: true },
    )
    vi.useRealTimers()
  })
})
