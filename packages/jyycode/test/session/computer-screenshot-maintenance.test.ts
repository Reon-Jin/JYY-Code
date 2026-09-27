import { expect, test } from "bun:test"
import { Context } from "effect"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { ComputerScreenshotMaintenanceScheduler } from "../../src/session/computer-screenshot-maintenance"

const context = Context.empty() as Context.Context<Session.Service>
const sessionID = SessionID.make("ses_screenshot_scheduler")

test("coalesces repeated actions without doing storage work on the action path", async () => {
  let prunes = 0
  let budgets = 0
  let collections = 0
  const scheduler = new ComputerScreenshotMaintenanceScheduler({
    delayMs: 60_000,
    prune: async () => {
      prunes++
      return { more: false, released: [{ digest: "a".repeat(64), bytes: 100 }] }
    },
    budget: async () => {
      budgets++
      return { more: false, released: [] }
    },
    collect: async (released) => {
      collections += released.length
    },
  })
  for (let index = 0; index < 20; index++) scheduler.enqueue({ sessionID, context })
  expect({ prunes, budgets, collections }).toEqual({ prunes: 0, budgets: 0, collections: 0 })
  await scheduler.flush()
  expect({ prunes, budgets, collections }).toEqual({ prunes: 1, budgets: 1, collections: 1 })
})

test("continues a bounded global budget sweep after the initial pass", async () => {
  let prunes = 0
  let budgets = 0
  const collected: string[] = []
  const scheduler = new ComputerScreenshotMaintenanceScheduler({
    delayMs: 60_000,
    prune: async () => {
      prunes++
      return { more: false, released: [] }
    },
    budget: async () => {
      budgets++
      return {
        more: budgets === 1,
        released: [{ digest: String(budgets).repeat(64), bytes: 100 }],
      }
    },
    collect: async (released) => {
      collected.push(...released.map((item) => item.digest))
    },
  })
  scheduler.enqueue({ sessionID, context })
  await scheduler.flush()
  expect({ prunes, budgets, collected: collected.length }).toEqual({ prunes: 1, budgets: 1, collected: 1 })
  await scheduler.flush()
  expect({ prunes, budgets, collected: collected.length }).toEqual({ prunes: 1, budgets: 2, collected: 2 })
})
