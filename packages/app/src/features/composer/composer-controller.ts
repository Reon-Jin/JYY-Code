import { createSignal } from "solid-js"
import type { DesktopClient } from "../../data/sdk"
import type { ModelSelection } from "./model-catalog"

export type ComposerAttachment = {
  type: "file"
  mime: string
  filename: string
  url: string
}

export type Value<T> = T | (() => T)

function resolve<T>(value: Value<T>) {
  return typeof value === "function" ? (value as () => T)() : value
}

export type ComposerControllerInput = {
  client: Pick<DesktopClient, "session">
  directory: Value<string>
  sessionID: Value<string>
  agent: Value<string>
  model: Value<ModelSelection>
  agentClusterEnabled: Value<boolean>
  draftStore?: Map<string, string>
}

const processDrafts = new Map<string, string>()

function slashCommand(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  return { command: match[1], arguments: match[2] ?? "" }
}

export function createComposerController(input: ComposerControllerInput) {
  const draftStore = input.draftStore ?? processDrafts
  const draftKey = `${resolve(input.directory)}\u0000${resolve(input.sessionID)}`
  const [draft, setDraftSignal] = createSignal(draftStore.get(draftKey) ?? "")
  const [sending, setSending] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const [lastFailedDraft, setLastFailedDraft] = createSignal<string>()
  let lastFailedAttachments: readonly ComposerAttachment[] = []
  let inFlight: Promise<void> | undefined
  let stopInFlight: Promise<void> | undefined

  function setDraft(value: string) {
    setDraftSignal(value)
    if (value) draftStore.set(draftKey, value)
    else draftStore.delete(draftKey)
    return value
  }

  function send(
    text = draft(),
    selection?: { agent: string; model: ModelSelection },
    attachments: readonly ComposerAttachment[] = [],
  ): Promise<void> {
    if (inFlight) return inFlight
    setDraft(text)
    if (!text.trim() && attachments.length === 0) return Promise.resolve()

    setFailure(undefined)
    setSending(true)
    const task = Promise.resolve().then(async () => {
      try {
        const directory = resolve(input.directory)
        const sessionID = resolve(input.sessionID)
        const agent = selection?.agent ?? resolve(input.agent)
        const model = selection?.model ?? resolve(input.model)
        const command = attachments.length === 0 ? slashCommand(text) : undefined
        if (command) {
          await input.client.session.command(
            {
              directory,
              sessionID,
              agent,
              model: `${model.providerID}/${model.modelID}`,
              ...command,
            },
            { throwOnError: true },
          )
        } else {
          await input.client.session.promptAsync(
            {
              directory,
              sessionID,
              agent,
              model: { providerID: model.providerID, modelID: model.modelID },
              ...(model.variant ? { variant: model.variant } : {}),
              agentCluster: { enabled: resolve(input.agentClusterEnabled) },
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments],
            },
            { throwOnError: true },
          )
        }
        setDraft("")
        setLastFailedDraft(undefined)
        lastFailedAttachments = []
      } catch (cause) {
        setDraft(text)
        setLastFailedDraft(text)
        lastFailedAttachments = attachments
        setFailure(cause)
        throw cause
      } finally {
        inFlight = undefined
        setSending(false)
      }
    })
    inFlight = task
    return task
  }

  function interruptAndSend(
    text = draft(),
    selection?: { agent: string; model: ModelSelection },
    attachments: readonly ComposerAttachment[] = [],
  ): Promise<void> {
    if (inFlight) return inFlight
    setDraft(text)
    if (!text.trim() && attachments.length === 0) return Promise.resolve()

    setFailure(undefined)
    setSending(true)
    const task = Promise.resolve().then(async () => {
      try {
        const directory = resolve(input.directory)
        const sessionID = resolve(input.sessionID)
        const agent = selection?.agent ?? resolve(input.agent)
        const model = selection?.model ?? resolve(input.model)
        const interruptPrompt = (input.client.session as typeof input.client.session & {
          interruptPrompt?: (parameters: unknown, options?: { throwOnError: boolean }) => Promise<unknown>
        }).interruptPrompt
        if (!interruptPrompt) throw new Error("This server does not support interrupting a child assignment")
        await interruptPrompt(
          {
            directory,
            sessionID,
            agent,
            model: { providerID: model.providerID, modelID: model.modelID },
            ...(model.variant ? { variant: model.variant } : {}),
            agentCluster: { enabled: false },
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments],
          },
          { throwOnError: true },
        )
        setDraft("")
        setLastFailedDraft(undefined)
        lastFailedAttachments = []
      } catch (cause) {
        setDraft(text)
        setLastFailedDraft(text)
        lastFailedAttachments = attachments
        setFailure(cause)
        throw cause
      } finally {
        inFlight = undefined
        setSending(false)
      }
    })
    inFlight = task
    return task
  }

  function retry() {
    const text = lastFailedDraft()
    if (text === undefined) return Promise.resolve()
    setDraft(text)
    return send(text, undefined, lastFailedAttachments)
  }

  function stop(): Promise<void> {
    if (stopInFlight) return stopInFlight
    setStopping(true)
    setFailure(undefined)
    const task = Promise.resolve().then(async () => {
      try {
        await input.client.session.abort(
          { directory: resolve(input.directory), sessionID: resolve(input.sessionID) },
          { throwOnError: true },
        )
      } catch (cause) {
        setFailure(cause)
        throw cause
      } finally {
        stopInFlight = undefined
        setStopping(false)
      }
    })
    stopInFlight = task
    return task
  }

  return { draft, setDraft, sending, stopping, failure, lastFailedDraft, send, interruptAndSend, retry, stop }
}

export type ComposerController = ReturnType<typeof createComposerController>
