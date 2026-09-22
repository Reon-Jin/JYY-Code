import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import { Effect, Exit, Scope, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { AppProcess } from "@jyycode-ai/core/process"
import windowsScript from "./windows.ps1" with { type: "file" }
import type { Action, Observation } from "./native"

type Reply = Observation | { error: string }

type Worker = {
  request: (input: Action, image: string, signal?: AbortSignal) => Promise<Observation>
  close: () => Promise<void>
  isClosed: () => boolean
}

function pump(source: Stream.Stream<Uint8Array, unknown>, target: PassThrough) {
  return Stream.runForEach(source, (chunk) => Effect.sync(() => target.write(Buffer.from(chunk)))).pipe(
    Effect.ensuring(Effect.sync(() => target.end())),
  )
}

async function start(): Promise<Worker> {
  const dir = await mkdtemp(path.join(tmpdir(), "jyycode-computer-worker-"))
  const script = path.join(dir, "computer.ps1")
  let scope: Scope.Scope | undefined
  try {
    await writeFile(script, Buffer.from(await Bun.file(windowsScript).arrayBuffer()))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let errorText = ""
    stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString("utf8")).slice(-4096) })
    const spawned = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AppProcess.Service
        const processScope = yield* Scope.make()
        const input = Stream.fromAsyncIterable(stdin as AsyncIterable<Uint8Array>, (error) => error as PlatformError.PlatformError)
        const handle = yield* service.spawn({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Worker"],
          stdin: input,
          env: { mode: "inherit-allowlist" },
          output: "capture",
        }).pipe(Effect.provideService(Scope.Scope, processScope))
        yield* Effect.forkScoped(pump(handle.stdout, stdout)).pipe(Effect.provideService(Scope.Scope, processScope))
        yield* Effect.forkScoped(pump(handle.stderr, stderr)).pipe(Effect.provideService(Scope.Scope, processScope))
        return { handle, processScope }
      }).pipe(Effect.provide(AppProcess.defaultLayer)),
    )
    scope = spawned.processScope
    const lines = createInterface({ input: stdout, crlfDelay: Infinity })
    let readyResolve: (() => void) | undefined
    let readyReject: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    let pending: { resolve: (value: Observation) => void; reject: (error: Error) => void } | undefined
    let closed = false
    let closing: Promise<void> | undefined
    const onExit = () => { try { process.kill(Number(spawned.handle.pid)) } catch { /* already exited */ } }
    process.once("exit", onExit)
    const fail = (error: Error) => {
      readyReject?.(error)
      pending?.reject(error)
      pending = undefined
    }
    lines.on("line", (line) => {
      let result: Reply | { ready: true }
      try { result = JSON.parse(line) }
      catch { fail(new Error(`Computer helper returned invalid JSON: ${line.slice(0, 200)}`)); void close(); return }
      if ("ready" in result) { readyResolve?.(); readyResolve = undefined; readyReject = undefined; return }
      if (!pending) return
      const request = pending
      pending = undefined
      if ("error" in result) request.reject(new Error(result.error))
      else request.resolve(result)
    })
    const close = (reason = new Error("Computer helper stopped")) => {
      if (closing) return closing
      closed = true
      shared = undefined
      fail(reason)
      lines.close()
      stdin.end()
      process.removeListener("exit", onExit)
      closing = (async () => {
        await Effect.runPromise(Scope.close(spawned.processScope, Exit.void)).catch(() => undefined)
        await rm(dir, { recursive: true, force: true })
      })()
      return closing
    }
    void Effect.runPromise(spawned.handle.exitCode).then(
      (code) => { if (!closed) { fail(new Error(errorText.trim() || `Computer helper exited with ${code}`)); void close() } },
      (cause) => { if (!closed) { fail(new Error(String(cause))); void close() } },
    )
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Computer helper startup timed out")), 15_000) }),
      ])
    }
    catch (error) { await close(); throw error }
    finally { clearTimeout(startupTimer) }
    return {
      request: (input, image, signal) => new Promise<Observation>((resolve, reject) => {
        if (closed) { reject(new Error("Computer helper stopped")); return }
        if (pending) { reject(new Error("Computer helper is already processing an action")); return }
        if (signal?.aborted) { reject(new Error("Computer operation interrupted")); return }
        const abort = () => { void close(new Error("Computer operation interrupted")) }
        signal?.addEventListener("abort", abort, { once: true })
        const timeout = setTimeout(() => { void close(new Error("Computer operation timed out")) }, 30_000)
        pending = {
          resolve: (value) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); resolve(value) },
          reject: (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error) },
        }
        try { stdin.write(JSON.stringify({ input, image }) + "\n") }
        catch (error) { void close(error instanceof Error ? error : new Error(String(error))) }
      }),
      close,
      isClosed: () => closed,
    }
  } catch (error) {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

let shared: Promise<Worker> | undefined
let tail: Promise<unknown> = Promise.resolve()

export function runWindows(input: Action, image: string, signal?: AbortSignal) {
  const run = async () => {
    const worker = await (shared ??= start().catch((error) => { shared = undefined; throw error }))
    try { return await worker.request(input, image, signal) }
    catch (error) {
      if (worker.isClosed()) await worker.close()
      throw error
    }
  }
  const current = tail.then(run, run)
  tail = current.catch(() => undefined)
  return current
}

export async function stopWindows() {
  if (shared) await (await shared).close()
}
