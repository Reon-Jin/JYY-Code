import { describe, expect, it, vi } from "vitest"
import { createComposerController } from "./composer-controller"

const directory = "C:\\work\\demo"
const sessionID = "ses_1"
const model = { providerID: "openai", modelID: "gpt-5" }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(draftStore = new Map<string, string>(), requestDirectory?: string) {
  const client = {
    session: {
      promptAsync: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      command: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      abort: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: true })),
      interruptPrompt: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      terminate: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
    },
  }
  const controller = createComposerController({
    client: client as never,
    directory: () => directory,
    ...(requestDirectory ? { requestDirectory: () => requestDirectory } : {}),
    sessionID: () => sessionID,
    agent: () => "build",
    model: () => model,
    draftStore,
  })
  return { client, controller }
}

describe("createComposerController", () => {
  it("submits exactly one async prompt", async () => {
    const { client, controller } = setup()
    const pending = deferred()
    client.session.promptAsync.mockImplementationOnce(() => pending.promise.then(() => ({ data: undefined })))

    const promise = controller.send("hello")
    const duplicate = controller.send("hello")
    expect(duplicate).toBe(promise)
    pending.resolve()
    await promise

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      {
        directory,
        sessionID,
        agent: "build",
        model,
        parts: [{ type: "text", text: "hello" }],
      },
      { throwOnError: true },
    )
    expect(controller.draft()).toBe("")
  })

  it("submits file parts and allows an attachment-only prompt", async () => {
    const { client, controller } = setup()
    const attachment = {
      type: "file" as const,
      mime: "application/pdf",
      filename: "report.pdf",
      url: "data:application/pdf;base64,JVBERi0=",
    }

    await controller.send("", undefined, [attachment])

    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ parts: [attachment] }), {
      throwOnError: true,
    })
  })

  it("executes a leading Skill slash as a Session command", async () => {
    const { client, controller } = setup()

    await controller.send("/pdf polish this report")

    expect(client.session.command).toHaveBeenCalledWith(
      {
        directory,
        sessionID,
        agent: "build",
        model: "openai/gpt-5",
        command: "pdf",
        arguments: "polish this report",
      },
      { throwOnError: true },
    )
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("keeps the draft when submission fails and retries through send", async () => {
    const { client, controller } = setup()
    client.session.promptAsync.mockRejectedValueOnce(new Error("offline"))

    await expect(controller.send("keep me")).rejects.toThrow("offline")
    expect(controller.draft()).toBe("keep me")
    expect(controller.lastFailedDraft()).toBe("keep me")

    await controller.retry()
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    expect((client.session.promptAsync.mock.calls[1]?.[0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "keep me" },
    ])
  })

  it("checks trimmed emptiness but sends original text", async () => {
    const { client, controller } = setup()
    await controller.send("   ")
    expect(client.session.promptAsync).not.toHaveBeenCalled()

    await controller.send("  hello  ")
    expect((client.session.promptAsync.mock.calls[0]?.[0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "  hello  " },
    ])
  })

  it("sends a queued prompt with its captured Agent and model", async () => {
    const { client, controller } = setup()
    const queuedModel = { providerID: "deepseek", modelID: "deepseek-reasoner", variant: "high" }
    await controller.send("queued", { agent: "plan", model: queuedModel })

    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "plan",
        model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
        variant: "high",
        parts: [{ type: "text", text: "queued" }],
      }),
      { throwOnError: true },
    )
  })

  it("stops a running session through abort", async () => {
    const { client, controller } = setup()
    await controller.stop()
    expect(client.session.abort).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
  })

  it("terminates a plan child assignment through the terminate endpoint", async () => {
    const { client, controller } = setup()

    const promise = controller.terminate()
    const duplicate = controller.terminate()
    expect(duplicate).toBe(promise)
    await promise

    expect(client.session.terminate).toHaveBeenCalledTimes(1)
    expect(client.session.terminate).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  it("uses the child session directory for plan-child API calls", async () => {
    const childDirectory = "C:\\work\\demo\\plan\\ses_child"
    const { client, controller } = setup(new Map(), childDirectory)

    await controller.send("steer")
    await controller.stop()
    await controller.terminate()

    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ directory: childDirectory }),
      { throwOnError: true },
    )
    expect(client.session.abort).toHaveBeenCalledWith(
      { directory: childDirectory, sessionID },
      { throwOnError: true },
    )
    expect(client.session.terminate).toHaveBeenCalledWith(
      { directory: childDirectory, sessionID },
      { throwOnError: true },
    )
  })

  it("interrupts the current child assignment before steering it", async () => {
    const { client, controller } = setup()

    await controller.interruptAndSend("Please stop and explain the blocker")

    expect(client.session.interruptPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        directory,
        sessionID,
        agent: "build",
        parts: [{ type: "text", text: "Please stop and explain the blocker" }],
      }),
      { throwOnError: true },
    )
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("keeps an unsent draft in process memory across controller recreation", () => {
    const draftStore = new Map<string, string>()
    const first = setup(draftStore).controller
    first.setDraft("continue after restart")

    const restored = setup(draftStore).controller
    expect(restored.draft()).toBe("continue after restart")
  })

  it("disposes an unfinished request, cancels the session, and suppresses late updates", async () => {
    const draftStore = new Map<string, string>()
    const { client, controller } = setup(draftStore)
    const pending = deferred()
    client.session.promptAsync.mockImplementationOnce(() => pending.promise.then(() => ({ data: undefined })))

    const request = controller.send("cancel me")
    await controller.dispose({ cancelSession: true })
    expect(client.session.abort).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })

    pending.resolve()
    await request
    expect(controller.draft()).toBe("cancel me")
    expect(controller.sending()).toBe(true)
  })
})
