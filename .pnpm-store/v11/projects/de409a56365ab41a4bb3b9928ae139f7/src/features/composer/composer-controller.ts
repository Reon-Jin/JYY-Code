import { createSignal } from "solid-js"
import type { DesktopClient } from "../../data/sdk"
import type { ModelSelection } from "./model-catalog"

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

export function createComposerController(input: ComposerControllerInput) {
  const draftStore = input.draftStore ?? processDrafts
  const draftKey = `${resolve(input.directory)}\u0000${resolve(input.sessionID)}`
  const [draft, setDraftSignal] = createSignal(draftStore.get(draftKey) ?? "")
  const [sending, setSending] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const [lastFailedDraft, setLastFailedDraft] = createSignal<string>()
  let inFlight: Promise<void> | undefined
  let stopInFlight: Promise<void> | undefined

  function setDraft(value: string) {
    setDraftSignal(value)
    if (value) draftStore.set(draftKey, value)
    else draftStore.delete(draftKey)
    return value
  }

  function send(text = draft(), selection?: { agent: string; model: ModelSelection }): Promise<void> {
    if (inFlight) return inFlight
    setDraft(text)
    if (!text.trim()) return Promise.resolve()

    setFailure(undefined)
    setSending(true)
    const task = Promise.resolve().then(async () => {
      try {
        await input.client.session.promptAsync(
          {
            directory: resolve(input.directory),
            sessionID: resolve(input.sessionID),
            agent: selection?.agent ?? resolve(input.agent),
            model: selection?.model ?? resolve(input.model),
            agentCluster: { enabled: resolve(input.agentClusterEnabled) },
            parts: [{ type: "text", text }],
          },
          { throwOnError: true },
        )
        setDraft("")
        setLastFailedDraft(undefined)
      } catch (cause) {
        setDraft(text)
        setLastFailedDraft(text)
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
    return send(text)
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

  return { draft, setDraft, sending, stopping, failure, lastFailedDraft, send, retry, stop }
}

export type ComposerController = ReturnType<typeof createComposerController>
