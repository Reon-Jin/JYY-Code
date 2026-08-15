import { describe, expect } from "bun:test"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Scope } from "effect"
import { AppProcess } from "@jyycode-ai/core/process"
import { isProcessAlive } from "@jyycode-ai/core/process-supervisor"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { BackgroundProcess } from "@/process/job"
import { Shell } from "@/shell/shell"
import { commandProcess } from "@/tool/shell/command"
import { LSPLaunch } from "@/lsp/launch"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(BackgroundProcess.defaultLayer, AppProcess.defaultLayer, CrossSpawnSpawner.defaultLayer))

const childScript = [
  "const { spawn } = require('node:child_process')",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })",
  "console.log(child.pid)",
  "console.error('child-ready')",
  "setInterval(() => {}, 60000)",
].join(";")

function nodeCommand() {
  return ChildProcess.make(process.execPath, ["-e", childScript], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
  })
}

async function waitForLine(stream: NodeJS.ReadableStream) {
  let text = ""
  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      text += chunk.toString()
      const line = text.split(/\r?\n/)[0]
      if (!line) return
      stream.removeListener("data", onData)
      stream.removeListener("error", onError)
      resolve(line)
    }
    const onError = (error: Error) => {
      stream.removeListener("data", onData)
      reject(error)
    }
    stream.on("data", onData)
    stream.on("error", onError)
  })
}

async function waitUntilDead(pid: number) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!isProcessAlive(pid)) return true
    await Bun.sleep(25)
  }
  return false
}

describe("runtime integration", () => {
  it.live("cancels background jobs and shell trees with verified descendant cleanup", () =>
    Effect.gen(function* () {
      const processes = yield* BackgroundProcess.Service
      const background = yield* processes.start({
        command: nodeCommand(),
        rawCommand: "runtime integration tree",
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
      })

      const backgroundOutput = yield* pollWithTimeout(
        processes.output({ id: background.id, limit: 20 }).pipe(
          Effect.map((value) => {
            const pid = Number(value.output.match(/\b\d+\b/)?.[0])
            return value.output.includes("child-ready") && Number.isSafeInteger(pid) ? { value, pid } : undefined
          }),
        ),
        "background process did not produce compatible output",
      )
      const result = yield* processes.kill({ id: background.id, forceAfterMs: 1_000 })
      expect(result?.status).toBe("cancelled")
      expect(result?.termination_reason).toBe("user_requested")
      expect(yield* Effect.promise(() => waitUntilDead(backgroundOutput.pid))).toBe(true)

      const shell = Shell.acceptable()
      const shellCommand =
        process.platform === "win32"
          ? `$p = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '-e','setInterval(() => {}, 60000)' -PassThru; Write-Output $p.Id; Write-Error 'child-ready'; while ($true) { Start-Sleep -Seconds 60 }`
          : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${childScript.replaceAll("'", "'\\''")}'`
      const shellInfo = yield* processes.start({
        command: commandProcess(shell, shellCommand, process.cwd(), process.env),
        rawCommand: shellCommand,
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
      })
      const shellOutput = yield* pollWithTimeout(
        processes.output({ id: shellInfo.id, limit: 20 }).pipe(
          Effect.map((value) => {
            const pid = Number(value.output.match(/\b\d+\b/)?.[0])
            return Number.isSafeInteger(pid) && pid > 0 ? { value, pid } : undefined
          }),
        ),
        "shell process did not produce compatible output",
      )
      const shellResult = yield* processes.kill({ id: shellInfo.id, forceAfterMs: 1_000 })
      expect(shellResult?.status).toBe("cancelled")
      expect(yield* Effect.promise(() => waitUntilDead(shellOutput.pid))).toBe(true)
      expect(backgroundOutput.value.output).toContain("child-ready")
    }),
  )

  it.live("restarts LSP adapters without stale servers and preserves streamed output", () =>
    Effect.gen(function* () {
      const appProcess = yield* AppProcess.Service
      const scope = yield* Scope.make()
      const reset = LSPLaunch.configureFrom(appProcess, scope)
      const spec = {
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 60000)"],
        cwd: process.cwd(),
        env: { mode: "inherit-allowlist" as const },
        output: "capture" as const,
      }

      try {
        const first = LSPLaunch.spawn(spec)
        yield* Effect.promise(() => first.ready)
        expect(yield* Effect.promise(() => waitForLine(first.stdout))).toBe("ready")
        const firstTermination = yield* Effect.promise(() => first.terminate())
        expect(["killed", "exited"]).toContain(firstTermination.state)
        expect(yield* Effect.promise(() => waitUntilDead(first.pid))).toBe(true)

        const second = LSPLaunch.spawn(spec)
        yield* Effect.promise(() => second.ready)
        expect(second.pid).not.toBe(first.pid)
        expect(yield* Effect.promise(() => waitForLine(second.stdout))).toBe("ready")
        const secondTermination = yield* Effect.promise(() => second.terminate())
        expect(["killed", "exited"]).toContain(secondTermination.state)
        expect(yield* Effect.promise(() => waitUntilDead(second.pid))).toBe(true)
      } finally {
        reset()
      }
    }),
  )

  cliIt.live(
    "ACP shutdown reaches a terminal process state after stdin closes",
    ({ jyycode }) =>
      Effect.gen(function* () {
        const exited = yield* Effect.scoped(
          Effect.gen(function* () {
            const acp = yield* jyycode.acp()
            return acp.exited
          }),
        )
        const code = yield* Effect.promise(() => exited)
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
