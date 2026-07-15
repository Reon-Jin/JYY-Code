import { createSignal, type Accessor, type Setter } from "solid-js"
import type { ModelSelection } from "./model-catalog"

export type QueuedPrompt = {
  id: string
  text: string
  agent: string
  model: ModelSelection
}

type QueueChannel = {
  items: Accessor<readonly QueuedPrompt[]>
  setItems: Setter<readonly QueuedPrompt[]>
}

export type ComposerQueueStore = Map<string, QueueChannel>

const processQueues = createComposerQueueStore()
let fallbackID = 0

function defaultID() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  fallbackID += 1
  return `queued_${Date.now()}_${fallbackID}`
}

export function createComposerQueueStore(): ComposerQueueStore {
  return new Map()
}

export function createComposerQueue(input: {
  directory: string
  sessionID: string
  store?: ComposerQueueStore
  createID?: () => string
}) {
  const store = input.store ?? processQueues
  const key = `${input.directory}\u0000${input.sessionID}`
  let channel = store.get(key)
  if (!channel) {
    const [items, setItems] = createSignal<readonly QueuedPrompt[]>([])
    channel = { items, setItems }
    store.set(key, channel)
  }

  function enqueue(value: Omit<QueuedPrompt, "id">) {
    const item = { ...value, id: (input.createID ?? defaultID)() }
    channel!.setItems((items) => [...items, item])
    return item
  }

  function remove(id: string) {
    channel!.setItems((items) => items.filter((item) => item.id !== id))
  }

  function shift() {
    const first = channel!.items()[0]
    if (first) channel!.setItems((items) => items.slice(1))
    return first
  }

  return { items: channel.items, enqueue, remove, shift }
}
