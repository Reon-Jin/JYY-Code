import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FileWriteLock, lockPathFor } from "@/file/write-lock"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function createLock() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jyycode-write-lock-test-"))
  tempDirectories.push(directory)
  return new FileWriteLock({ directory, retryMs: 5, staleMs: 50 })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe("FileWriteLock", () => {
  test("waits for another holder of the same path", async () => {
    const locks = await createLock()
    const file = path.join(tempDirectories.at(-1)!, "file.txt")
    const first = await locks.acquire(file, { holder: "child-a" })
    let entered = false
    const second = locks.acquire(file, { holder: "child-b" }).then((handle) => {
      entered = true
      return handle
    })

    await sleep(20)
    expect(entered).toBe(false)

    first.release()
    const secondHandle = await second
    expect(entered).toBe(true)
    expect(secondHandle.waitedMs).toBeGreaterThanOrEqual(15)
    secondHandle.release()
  })

  test("allows different paths to be held concurrently", async () => {
    const locks = await createLock()
    const directory = tempDirectories.at(-1)!
    const first = await locks.acquire(path.join(directory, "one.txt"), { holder: "child-a" })
    let entered = false
    const second = locks.acquire(path.join(directory, "two.txt"), { holder: "child-b" }).then((handle) => {
      entered = true
      return handle
    })

    const secondHandle = await second
    expect(entered).toBe(true)
    secondHandle.release()
    first.release()
  })

  test("stops waiting when the caller is cancelled", async () => {
    const locks = await createLock()
    const file = path.join(tempDirectories.at(-1)!, "file.txt")
    const first = await locks.acquire(file, { holder: "child-a" })
    const controller = new AbortController()
    const second = locks.acquire(file, { holder: "child-b", signal: controller.signal })
    controller.abort()

    await expect(second).rejects.toMatchObject({ name: "AbortError" })
    first.release()
  })

  test("reclaims a stale lock owned by a dead process", async () => {
    const locks = await createLock()
    const file = path.join(tempDirectories.at(-1)!, "file.txt")
    const lockPath = lockPathFor(file, tempDirectories.at(-1)!)
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        path: path.resolve(file),
        holder: "dead-process",
        pid: 999_999_999,
        acquired_at: new Date(Date.now() - 1_000).toISOString(),
        token: "stale-token",
      }),
    )

    const handle = await locks.acquire(file, { holder: "child-b" })
    expect(handle.waitedMs).toBeGreaterThanOrEqual(0)
    handle.release()
  })

  test("does not release a lock that no longer belongs to the handle", async () => {
    const locks = await createLock()
    const file = path.join(tempDirectories.at(-1)!, "file.txt")
    const lockPath = lockPathFor(file, tempDirectories.at(-1)!)
    const first = await locks.acquire(file, { holder: "child-a" })
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        path: path.resolve(file),
        holder: "child-b",
        pid: process.pid,
        acquired_at: new Date().toISOString(),
        token: "new-token",
      }),
    )

    first.release()
    expect(await fs.readFile(lockPath, "utf8")).toContain("new-token")
  })

  test("releases the lock on an error path", async () => {
    const locks = await createLock()
    const file = path.join(tempDirectories.at(-1)!, "file.txt")
    const first = await locks.acquire(file, { holder: "child-a" })

    try {
      throw new Error("simulated write failure")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    } finally {
      first.release()
    }

    const second = await locks.acquire(file, { holder: "child-b" })
    second.release()
  })
})
