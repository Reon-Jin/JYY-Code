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
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: sessionID === "ses_child" ? { ...session, id: sessionID, parentID: "ses_1", agent: "coder" } : session,
      })),
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
      { directory, roots: true },
      { throwOnError: true },
    )
  })

  it("lists root and child sessions for usage aggregation", async () => {
    const { api, client } = createHarness()

    await api.listAll()

    expect(client.session.list).toHaveBeenCalledWith(
      { directory, roots: false },
      { throwOnError: true },
    )
  })

  it.each([
    ["ses_1", undefined],
    ["ses_child", "ses_1"],
  ])("loads an exact active Session route for %s", async (sessionID, parentID) => {
    const { api, client } = createHarness()

    const loaded = await api.load(sessionID)

    expect(client.session.get).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
    expect(loaded).toMatchObject({ id: sessionID, ...(parentID ? { parentID } : {}) })
  })

  it("does not persist an unnecessary false override when creating a session", async () => {
    const { api, client } = createHarness()

    await api.create({ agent: "build", model })

    expect(client.session.create).toHaveBeenCalledWith(
      { directory, agent: "build", model },
      { throwOnError: true },
    )
  })

  it("forwards an explicit Multi-Agent creation override", async () => {
    const { api, client } = createHarness()

    await api.create({ agent: "build", model, multiAgent: true })

    expect(client.session.create).toHaveBeenCalledWith(
      { directory, agent: "build", model, multiAgent: true },
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
