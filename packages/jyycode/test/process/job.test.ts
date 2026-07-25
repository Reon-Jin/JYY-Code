import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BackgroundProcess } from "@/process/job"
import { testEffect } from "../lib/effect"
import { pollWithTimeout } from "../lib/effect"

const it = testEffect(BackgroundProcess.defaultLayer)

describe("process.job", () => {
  it.instance("starts a process and captures output while running", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const code = "console.log('ready'); setTimeout(() => {}, 30000)"
      const proc = yield* service.start({
        command: ChildProcess.make(process.execPath, ["-e", code], {
          cwd: process.cwd(),
          env: process.env,
          stdin: "ignore",
        }),
        rawCommand: `${process.execPath} -e ${JSON.stringify(code)}`,
        cwd: process.cwd(),
        env: process.env,
        title: "test process",
      })

      const output = yield* pollWithTimeout(
        service
          .output({ id: proc.id, limit: 20 })
          .pipe(Effect.map((output) => (output.output.includes("ready") ? output : undefined))),
        "process output not captured",
      )

      expect(proc.id.startsWith("proc_")).toBe(true)
      expect(output.info?.status).toBe("running")
      expect(output.output).toContain("ready")

      yield* service.kill({ id: proc.id, forceAfterMs: 100 })
    }),
  )

  it.instance("reports missing process ids", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const output = yield* service.output({ id: "proc_missing" })

      expect(output.info).toBeUndefined()
    }),
  )
})
