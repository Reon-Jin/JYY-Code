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
  draftStore?: Map<string, string>
}

const processDrafts = new Map<string, string>()
const processDraftTouched = new Map<string, number>()
const PROCESS_DRAFT_TTL_MS = 30 * 60 * 1_000
const PROCESS_DRAFT_LIMIT = 128

function pruneProcessDrafts(now = Date.now()) {
  for (const [key, touched] of processDraftTouched) {
    if (now - touched <= PROCESS_DRAFT_TTL_MS && processDrafts.has(key)) continue
    processDraftTouched.delete(key)
    processDrafts.delete(key)
  }
  if (processDrafts.size <= PROCESS_DRAFT_LIMIT) return
  const entries = [...processDraftTouched.entries()].sort((left, right) => left[1] - right[1])
  for (const [key] of entries) {
    if (processDrafts.size <= PROCESS_DRAFT_LIMIT) break
    processDraftTouched.delete(key)
    processDrafts.delete(key)
  }
}

function slashCommand(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  return { command: match[1], arguments: match[2] ?? "" }
}

export function createComposerController(input: ComposerControllerInput) {
  const draftStore = input.draftStore ?? processDrafts
  const draftKey = `${resolve(input.directory)}\u0000${resolve(input.sessionID)}`
  if (draftStore === processDrafts) {
    pruneProcessDrafts()
    if (processDrafts.has(draftKey)) processDraftTouched.set(draftKey, Date.now())
  }
  const [draft, setDraftSignal] = createSignal(draftStore.get(draftKey) ?? "")
  const [sending, setSending] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [terminating, setTerminating] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const [lastFailedDraft, setLastFailedDraft] = createSignal<string>()
  let lastFailedAttachments: readonly ComposerAttachment[] = []
  let inFlight: Promise<void> | undefined
  let stopInFlight: Promise<void> | undefined
  let terminateInFlight: Promise<void> | undefined
  let disposed = false

  function setDraft(value: string) {
    if (disposed) return value
    setDraftSignal(value)
    if (value) draftStore.set(draftKey, value)
    else draftStore.delete(draftKey)
    if (draftStore === processDrafts) {
      if (value) processDraftTouched.set(draftKey, Date.now())
      else processDraftTouched.delete(draftKey)
      pruneProcessDrafts()
    }
    return value
  }

  function send(
    text = draft(),
    selection?: { agent: string; model: ModelSelection },
    attachments: readonly ComposerAttachment[] = [],
  ): Promise<void> {
    if (disposed) return Promise.resolve()
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
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments],
            },
            { throwOnError: true },
          )
        }
        if (!disposed) {
          setDraft("")
          setLastFailedDraft(undefined)
          lastFailedAttachments = []
        }
      } catch (cause) {
        if (!disposed) {
          setDraft(text)
          setLastFailedDraft(text)
          lastFailedAttachments = attachments
          setFailure(cause)
        }
        throw cause
      } finally {
        inFlight = undefined
        if (!disposed) setSending(false)
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
    if (disposed) return Promise.resolve()
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
        const session = input.client.session as typeof input.client.session & {
          interruptPrompt?: (parameters: unknown, options?: { throwOnError: boolean }) => Promise<unknown>
        }
        if (!session.interruptPrompt) throw new Error("This server does not support interrupting a child assignment")
        await session.interruptPrompt(
          {
            directory,
            sessionID,
            agent,
            model: { providerID: model.providerID, modelID: model.modelID },
            ...(model.variant ? { variant: model.variant } : {}),
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments],
          },
          { throwOnError: true },
        )
        if (!disposed) {
          setDraft("")
          setLastFailedDraft(undefined)
          lastFailedAttachments = []
        }
      } catch (cause) {
        if (!disposed) {
          setDraft(text)
          setLastFailedDraft(text)
          lastFailedAttachments = attachments
          setFailure(cause)
        }
        throw cause
      } finally {
        inFlight = undefined
        if (!disposed) setSending(false)
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
    if (disposed) return Promise.resolve()
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
        if (!disposed) setFailure(cause)
        throw cause
      } finally {
        stopInFlight = undefined
        if (!disposed) setStopping(false)
      }
    })
    stopInFlight = task
    return task
  }

  // Terminate a plan child assignment entirely: the server stops the child
  // run, parks the task, and notifies the parent session through its Inbox.
  function terminate(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (terminateInFlight) return terminateInFlight
    setTerminating(true)
    setFailure(undefined)
    const task = Promise.resolve().then(async () => {
      try {
        await input.client.session.terminate(
          { directory: resolve(input.directory), sessionID: resolve(input.sessionID) },
          { throwOnError: true },
        )
      } catch (cause) {
        if (!disposed) setFailure(cause)
        throw cause
      } finally {
        terminateInFlight = undefined
        if (!disposed) setTerminating(false)
      }
    })
    terminateInFlight = task
    return task
  }

  async function dispose(options: { cancelSession?: boolean } = {}) {
    if (disposed) return
    disposed = true
    const cancelSession = options.cancelSession ?? false
    const hadWork = Boolean(inFlight || stopInFlight || terminateInFlight)
    inFlight = undefined
    stopInFlight = undefined
    terminateInFlight = undefined
    if (!draftStore.get(draftKey)) {
      draftStore.delete(draftKey)
      if (draftStore === processDrafts) processDraftTouched.delete(draftKey)
    } else if (draftStore === processDrafts) {
      processDraftTouched.set(draftKey, Date.now())
      pruneProcessDrafts()
    }
    if (!cancelSession || !hadWork) return
    try {
      await input.client.session.abort(
        { directory: resolve(input.directory), sessionID: resolve(input.sessionID) },
        { throwOnError: true },
      )
    } catch {
      // Disposal must not surface an unhandled rejection after the owner is gone.
    }
  }

  return {
    draft,
    setDraft,
    sending,
    stopping,
    terminating,
    failure,
    lastFailedDraft,
    send,
    interruptAndSend,
    retry,
    stop,
    terminate,
    dispose,
  }
}

export type ComposerController = ReturnType<typeof createComposerController>
