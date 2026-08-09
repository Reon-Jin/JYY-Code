import type { EventPolicy } from "./policy"

export type HubItem<T> = { readonly event: T; readonly gap?: boolean }

export type PublishReport = {
  readonly delivered: number
  readonly coalesced: number
  readonly closed: number
  readonly gaps: number
}

export type HubSubscription<T> = {
  readonly id: string
  readonly drain: (limit?: number) => HubItem<T>[]
  readonly close: () => void
  readonly pending: () => number
  readonly isClosed: () => boolean
}

type Subscriber<T> = {
  id: string
  policy: EventPolicy
  queue: HubItem<T>[]
  keys: Map<string, number>
  closed: boolean
  gap: boolean
}

/** In-memory bounded hub for event streams. It never retains an unbounded raw delta queue. */
export class ReliableHub<T> {
  readonly #subscribers = new Map<string, Subscriber<T>>()

  subscribe(id: string, policy: EventPolicy): HubSubscription<T> {
    if (this.#subscribers.has(id)) throw new Error(`subscriber already exists: ${id}`)
    const subscriber: Subscriber<T> = { id, policy, queue: [], keys: new Map(), closed: false, gap: false }
    this.#subscribers.set(id, subscriber)
    return {
      id,
      drain: (limit = Number.POSITIVE_INFINITY) => {
        const items = subscriber.queue.splice(0, Math.max(0, limit))
        subscriber.keys.clear()
        if (subscriber.gap && items.length > 0) {
          subscriber.gap = false
          return [{ event: items[0]!.event, gap: true }, ...items.slice(1)]
        }
        subscriber.gap = false
        return items
      },
      close: () => {
        subscriber.closed = true
        this.#subscribers.delete(id)
      },
      pending: () => subscriber.queue.length,
      isClosed: () => subscriber.closed,
    }
  }

  publish(event: T, key?: string): PublishReport {
    const report = { delivered: 0, coalesced: 0, closed: 0, gaps: 0 }
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.closed) continue
      if (subscriber.policy.kind === "coalescible") {
        const eventKey = key ?? subscriber.policy.key?.(event) ?? "default"
        const existing = subscriber.keys.get(eventKey)
        if (existing !== undefined) {
          subscriber.queue[existing] = { event }
          report.coalesced++
          continue
        }
        if (subscriber.queue.length >= subscriber.policy.capacity) {
          subscriber.queue.shift()
          for (const [storedKey, index] of subscriber.keys) {
            if (index === 0) subscriber.keys.delete(storedKey)
            else subscriber.keys.set(storedKey, index - 1)
          }
          subscriber.gap = true
          report.gaps++
        }
        subscriber.keys.set(eventKey, subscriber.queue.length)
      } else if (subscriber.queue.length >= subscriber.policy.capacity) {
        subscriber.closed = true
        this.#subscribers.delete(subscriber.id)
        report.closed++
        continue
      }
      subscriber.queue.push({ event })
      report.delivered++
    }
    return report
  }

  subscriberCount() {
    return this.#subscribers.size
  }
}
