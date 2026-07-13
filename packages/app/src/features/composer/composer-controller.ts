import { createSignal } from "solid-js"
import type { DesktopClient } from "../../data/sdk"
import type { ModelSelection } from "./model-catalog"

type Value<T> = T | (() => T)

function resolve<T>(value: Value<T>) {
  return typeof value === "function" ? (value as () => T)() : value
}

export type ComposerControllerInput = {
  client: Pick<DesktopClient, "session">
  directory: Value<string>
  sessionID: Value<string>
  agent: Value<string>
  model: Value<ModelSelection>
}

export function createComposerController(input: ComposerControllerInput) {
  const [draft, setDraft] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const [lastFailedDraft, setLastFailedDraft] = createSignal<string>()
  let inFlight: Promise<void> | undefined
  let stopInFlight: Promise<void> | undefined

  function send(text = draft()): Promise<void> {
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
            agent: resolve(input.agent),
            model: resolve(input.model),
            agentCluster: { enabled: false },
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
