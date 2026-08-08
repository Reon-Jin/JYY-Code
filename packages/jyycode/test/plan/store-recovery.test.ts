import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, spyOn } from "bun:test"
import type { PlanFile } from "../../src/plan/schema"
import { PlanStore } from "../../src/plan/store"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-plan-store-"))
  return {
    root,
    planPath: path.join(root, "plan.json"),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function plan(revision = 1): PlanFile {
  const now = new Date(1_700_000_000_000 + revision * 1_000).toISOString()
  return {
    title: "Store recovery",
    goal: "Keep one complete plan recoverable",
    status: "active",
    revision,
    current_step: "s1",
    steps: [
      {
        id: "s1",
        title: "Step",
        goal: "Test",
        done_criteria: "Done",
        status: "active",
        tasks: [],
      },
    ],
    created_at: now,
    updated_at: now,
  }
}

async function seed(store: PlanStore, planPath: string) {
  const value = plan()
  await store.enqueueWrite(planPath, {
    priority: "high",
    holder: "test",
    apply: () => ({
      mutate(target) {
        Object.assign(target, value)
      },
      result: undefined,
    }),
  })
}

async function update(store: PlanStore, planPath: string, revision: number) {
  return store.enqueueWrite(planPath, {
    priority: "high",
    holder: "test",
    apply: (latest) => ({
      mutate(target) {
        Object.assign(target, latest!, plan(revision))
      },
      result: revision,
    }),
  })
}

describe("PlanStore recovery", () => {
  it("keeps the target file present across a Windows-style replace fallback", async () => {
    const value = fixture()
    try {
      const store = new PlanStore({ pid: 41001 })
      await seed(store, value.planPath)
      const originalRename = fs.renameSync
      const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (String(source) === `${value.planPath}.tmp` && String(target) === value.planPath && fs.existsSync(target)) {
          const error = new Error("target exists") as NodeJS.ErrnoException
          error.code = "EPERM"
          throw error
        }
        return originalRename(source, target)
      })
      try {
        await expect(update(store, value.planPath, 2)).resolves.toBe(2)
      } finally {
        rename.mockRestore()
      }
      expect(fs.existsSync(value.planPath)).toBe(true)
      expect(store.read(value.planPath)?.revision).toBe(2)
      expect(fs.existsSync(`${value.planPath}.tmp`)).toBe(false)
    } finally {
      value.cleanup()
    }
  })

  it("leaves a complete temporary or backup candidate when the second rename fails", async () => {
    const value = fixture()
    try {
      const store = new PlanStore({ pid: 41002 })
      await seed(store, value.planPath)
      const originalRename = fs.renameSync
      const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (String(source) === `${value.planPath}.tmp` && String(target) === value.planPath) {
          const error = new Error("replace refused") as NodeJS.ErrnoException
          error.code = fs.existsSync(target) ? "EPERM" : "EIO"
          throw error
        }
        return originalRename(source, target)
      })
      try {
        await expect(update(store, value.planPath, 2)).rejects.toMatchObject({ code: "EIO" })
      } finally {
        rename.mockRestore()
      }

      expect(fs.existsSync(`${value.planPath}.tmp`)).toBe(true)
      expect(fs.readdirSync(value.root).some((entry) => entry.startsWith("plan.json.bak."))).toBe(true)
      expect(store.read(value.planPath)?.revision).toBe(2)

      await expect(update(store, value.planPath, 3)).resolves.toBe(3)
      expect(store.read(value.planPath)?.revision).toBe(3)
      expect(fs.existsSync(value.planPath)).toBe(true)
      expect(fs.existsSync(`${value.planPath}.tmp`)).toBe(false)
    } finally {
      value.cleanup()
    }
  })

  it("does not reclaim an old-looking lock owned by a live writer", async () => {
    const value = fixture()
    try {
      const store = new PlanStore({ pid: 41003 })
      await seed(store, value.planPath)
      const lockPath = `${value.planPath}.lock`
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 41003,
          holder: "active-writer",
          acquired_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      )
      const waitingStore = new PlanStore({
        waitTimeoutMs: 15,
        pollMs: 1,
        staleLockMs: 1,
        pid: 41004,
        isProcessAlive: (pid) => pid === 41003,
      })
      await expect(update(waitingStore, value.planPath, 2)).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
      expect(fs.existsSync(lockPath)).toBe(true)
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ holder: "active-writer" })
    } finally {
      value.cleanup()
    }
  })

  it("selects a complete crash-left temporary file for the next read and write", async () => {
    const value = fixture()
    try {
      const store = new PlanStore()
      const oldPlan = plan(1)
      const newPlan = plan(2)
      fs.writeFileSync(value.planPath, JSON.stringify(oldPlan, null, 2))
      fs.writeFileSync(`${value.planPath}.tmp`, JSON.stringify(newPlan, null, 2))

      expect(store.read(value.planPath)?.revision).toBe(2)
      await expect(update(store, value.planPath, 3)).resolves.toBe(3)
      expect(store.read(value.planPath)?.revision).toBe(3)
      expect(fs.existsSync(`${value.planPath}.tmp`)).toBe(false)
    } finally {
      value.cleanup()
    }
  })
})
