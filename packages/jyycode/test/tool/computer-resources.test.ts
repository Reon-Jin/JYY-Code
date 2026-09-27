import { expect, test } from "bun:test"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { startJsonLineWorker } from "@/tool/computer/json-line-worker"
import { LocalOCRParser } from "@/tool/computer/ocr"
import { LocalVisualParser } from "@/tool/computer/vision"
import { hasComputerSessions, registerComputerSession, releaseComputerSession } from "@/tool/computer/resources"

test("session cleanup is idempotent and preserves another session's ownership", async () => {
  const released: string[] = []
  registerComputerSession("a", async () => {
    released.push(`a:${hasComputerSessions()}`)
  })
  registerComputerSession("b", async () => {
    released.push(`b:${hasComputerSessions()}`)
  })
  await releaseComputerSession("a")
  await releaseComputerSession("a")
  await releaseComputerSession("b")
  expect(released).toEqual(["a:true", "b:false"])
})

test("a cleanup failure does not prevent a session from finishing", async () => {
  registerComputerSession("failed", async () => {
    throw new Error("simulated cleanup failure")
  })
  await releaseComputerSession("failed")
  expect(hasComputerSessions()).toBe(false)
})

test("an idle model worker exits and releases its script without keeping the application alive", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "idle.py")
  await writeFile(
    script,
    "import json, sys, os\nprint(json.dumps({'ready':True}), flush=True)\nfor line in sys.stdin:\n print(json.dumps({'pid':os.getpid(), 'script':__file__}), flush=True)\n",
  )
  const worker = await startJsonLineWorker({ asset: script, command: "python", idleTimeoutMs: 150 })
  try {
    const reply = await worker.request({})
    await Bun.sleep(400)
    expect(worker.isClosed()).toBe(true)
    await worker.close()
    expect(() => process.kill(Number(reply.pid), 0)).toThrow()
    expect(await stat(String(reply.script)).catch(() => undefined)).toBeUndefined()
  } finally {
    await worker.close()
  }
})

for (const kind of ["vision", "ocr"] as const) {
  test(`stopping ${kind} during detached warmup kills the child before it becomes ready`, async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "pid")
    const script = path.join(tmp.path, "warming.py")
    const weight = path.join(tmp.path, "model.pt")
    await writeFile(weight, "fake")
    await writeFile(
      script,
      `import os, time\nopen(${JSON.stringify(marker)}, 'w').write(str(os.getpid()))\ntime.sleep(20)\nprint('{"ready":true}', flush=True)\n`,
    )
    const parser =
      kind === "vision"
        ? new LocalVisualParser({ modelPath: weight, workerScriptPath: script })
        : new LocalOCRParser({ workerScriptPath: script })
    const warming = parser.health()
    try {
      for (let i = 0; i < 100 && !(await stat(marker).catch(() => undefined)); i++) await Bun.sleep(30)
      const pid = Number(await readFile(marker, "utf8"))
      const started = performance.now()
      await parser.close()
      expect(performance.now() - started).toBeLessThan(3000)
      expect((await warming).ready).toBe(false)
      expect(parser.isReady()).toBe(false)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await parser.close()
      await warming
    }
  })
}
