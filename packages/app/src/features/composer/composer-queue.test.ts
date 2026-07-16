import { describe, expect, it } from "vitest"
import { createComposerQueue, createComposerQueueStore } from "./composer-queue"

const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" }

describe("createComposerQueue", () => {
  it("keeps FIFO entries and their captured Agent/model", () => {
    const store = createComposerQueueStore()
    let nextID = 0
    const queue = createComposerQueue({
      directory: "C:\\work",
      sessionID: "ses_1",
      store,
      createID: () => `queued_${++nextID}`,
    })

    queue.enqueue({ text: "first", agent: "build", model, attachments: [] })
    queue.enqueue({ text: "second", agent: "plan", model: { ...model, modelID: "deepseek-reasoner" }, attachments: [] })

    expect(queue.items()).toEqual([
      { id: "queued_1", text: "first", agent: "build", model, attachments: [] },
      {
        id: "queued_2",
        text: "second",
        agent: "plan",
        model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
        attachments: [],
      },
    ])
    expect(queue.shift()?.text).toBe("first")
    expect(queue.items().map((item) => item.text)).toEqual(["second"])
  })

  it("restores the queue for the same session, isolates other sessions, and removes by id", () => {
    const store = createComposerQueueStore()
    const first = createComposerQueue({
      directory: "C:\\work",
      sessionID: "ses_1",
      store,
      createID: () => "queued_1",
    })
    first.enqueue({ text: "keep", agent: "build", model, attachments: [] })

    const restored = createComposerQueue({ directory: "C:\\work", sessionID: "ses_1", store })
    const other = createComposerQueue({ directory: "C:\\work", sessionID: "ses_2", store })
    expect(restored.items().map((item) => item.text)).toEqual(["keep"])
    expect(other.items()).toEqual([])

    restored.remove("queued_1")
    expect(first.items()).toEqual([])
  })

  it("moves entries before or after a drop target", () => {
    const queue = createComposerQueue({
      directory: "C:\\work",
      sessionID: "ses_1",
      store: createComposerQueueStore(),
      createID: (() => {
        let nextID = 0
        return () => `queued_${++nextID}`
      })(),
    })
    queue.enqueue({ text: "first", agent: "build", model, attachments: [] })
    queue.enqueue({ text: "second", agent: "build", model, attachments: [] })
    queue.enqueue({ text: "third", agent: "build", model, attachments: [] })

    queue.move("queued_3", "queued_1")
    expect(queue.items().map((item) => item.text)).toEqual(["third", "first", "second"])
    queue.move("queued_3", "queued_2", true)
    expect(queue.items().map((item) => item.text)).toEqual(["first", "second", "third"])
  })
})
