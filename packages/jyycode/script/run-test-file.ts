import { killProcessTreeVerified, type TerminationResult } from "@jyycode-ai/core/process-supervisor"
import path from "node:path"

export type RunTestFileResult = {
  readonly testPath: string
  readonly elapsedMs: number
  readonly exitCode: number
  readonly timedOut: boolean
  readonly termination?: TerminationResult
}

export type RunTestFileOptions = {
  readonly deadlineMs?: number
  readonly cwd?: string
}

function parseArgs(argv: readonly string[]) {
  const testPath = argv.find((arg) => !arg.startsWith("--"))
  if (!testPath) throw new Error("usage: bun run script/run-test-file.ts <test-path> [--deadline-ms <ms>]")
  const index = argv.indexOf("--deadline-ms")
  const deadlineMs = index === -1 ? undefined : Number(argv[index + 1])
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    throw new Error("--deadline-ms must be a positive finite number")
  }
  return { testPath, deadlineMs }
}

export async function runTestFile(testPath: string, options: RunTestFileOptions = {}): Promise<RunTestFileResult> {
  const absolutePath = path.resolve(options.cwd ?? process.cwd(), testPath)
  const deadlineMs = options.deadlineMs ?? 60_000
  const started = Date.now()
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", absolutePath], {
    cwd: options.cwd ?? process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
      new Promise<{ exitCode: number; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ exitCode: 124, timedOut: true }), deadlineMs)
        ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
      }),
    ])
    timedOut = result.timedOut
    if (!result.timedOut) {
      return {
        testPath: absolutePath,
        elapsedMs: Date.now() - started,
        exitCode: result.exitCode,
        timedOut: false,
      }
    }
    let termination: TerminationResult | undefined
    try {
      termination = await killProcessTreeVerified(child.pid, { graceMs: 3000, verifyMs: 5000 })
    } catch (error) {
      termination =
        error && typeof error === "object" && "result" in error ? (error.result as TerminationResult) : undefined
    }
    return {
      testPath: absolutePath,
      elapsedMs: Date.now() - started,
      exitCode: termination?.state === "kill_failed" ? 1 : 124,
      timedOut,
      termination,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await runTestFile(args.testPath, { deadlineMs: args.deadlineMs })
    if (result.exitCode !== 0) {
      process.stderr.write(
        `test-file-failed path=${result.testPath} elapsed_ms=${result.elapsedMs} remaining_pids=${JSON.stringify(result.termination?.remainingPids ?? [])}\n`,
      )
    }
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
