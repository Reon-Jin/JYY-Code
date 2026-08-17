import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@jyycode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(path.dirname(Global.Path.tmp)).toBe(path.join(os.tmpdir(), "jyycode"))
    expect(path.basename(Global.Path.tmp)).toBe(`process-${process.pid}`)
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("removes stale process temp directories when a new process starts", async () => {
    const stale = path.join(path.dirname(Global.Path.tmp), "process-4294967295")
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(stale, "stale.txt"), "stale")

    const child = Bun.spawn([process.execPath, "-e", "import '@jyycode-ai/core/global'"], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(
      await fs.stat(stale).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("removes the current process temp directory on exit", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "import { Global } from '@jyycode-ai/core/global'; await Bun.write(`${Global.Path.tmp}/exit-check.txt`, 'ok'); console.log(Global.Path.tmp)",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const tempPath = (await new Response(child.stdout).text()).trim()
    expect(await child.exited).toBe(0)
    expect(
      await fs.stat(tempPath).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })
})
