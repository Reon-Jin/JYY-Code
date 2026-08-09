import { createSignal, type Accessor, type Setter } from "solid-js"
import type { ModelSelection } from "./model-catalog"
import type { ComposerAttachment } from "./composer-controller"

export type QueuedPrompt = {
  id: string
  text: string
  agent: string
  model: ModelSelection
  attachments: readonly ComposerAttachment[]
}

type QueueChannel = {
  items: Accessor<readonly QueuedPrompt[]>
  setItems: Setter<readonly QueuedPrompt[]>
  owners: number
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
    channel = { items, setItems, owners: 0 }
    store.set(key, channel)
  }
  channel.owners += 1
  let disposed = false

  function enqueue(value: Omit<QueuedPrompt, "id">) {
    if (disposed) return undefined
    const item = { ...value, id: (input.createID ?? defaultID)() }
    channel!.setItems((items) => [...items, item])
    return item
  }

  function remove(id: string) {
    if (disposed) return
    channel!.setItems((items) => items.filter((item) => item.id !== id))
  }

  function move(id: string, targetID: string, after = false) {
    if (disposed) return
    if (id === targetID) return
    channel!.setItems((items) => {
      const item = items.find((entry) => entry.id === id)
      const targetIndex = items.findIndex((entry) => entry.id === targetID)
      if (!item || targetIndex < 0) return items

      const remaining = items.filter((entry) => entry.id !== id)
      const nextTargetIndex = remaining.findIndex((entry) => entry.id === targetID)
      const insertAt = nextTargetIndex + (after ? 1 : 0)
      return [...remaining.slice(0, insertAt), item, ...remaining.slice(insertAt)]
    })
  }

  function shift() {
    if (disposed) return undefined
    const first = channel!.items()[0]
    if (first) channel!.setItems((items) => items.slice(1))
    return first
  }

  function dispose(options: { clear?: boolean } = {}) {
    if (disposed) return
    disposed = true
    channel!.owners = Math.max(0, channel!.owners - 1)
    if (options.clear && channel!.owners === 0) channel!.setItems([])
    if (channel!.owners === 0 && channel!.items().length === 0 && store.get(key) === channel) store.delete(key)
  }

  return { items: channel.items, enqueue, remove, move, shift, dispose }
}
