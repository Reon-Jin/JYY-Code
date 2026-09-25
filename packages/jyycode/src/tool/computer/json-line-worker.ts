import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import { Effect, Exit, Scope, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { AppProcess } from "@jyycode-ai/core/process"

export type JsonLineWorker = {
  request: (input: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => Promise<void>
  isClosed: () => boolean
}

function pump(source: Stream.Stream<Uint8Array, unknown>, target: PassThrough) {
  return Stream.runForEach(source, (chunk) => Effect.sync(() => target.write(Buffer.from(chunk)))).pipe(
    Effect.ensuring(Effect.sync(() => target.end())),
  )
}

/** Local subprocess adapter. No shell is involved and only one request is in flight. */
export async function startJsonLineWorker(input: {
  asset: string
  command: string
  args?: string[]
  startupTimeoutMs?: number
}): Promise<JsonLineWorker> {
  const dir = await mkdtemp(path.join(tmpdir(), "jyycode-computer-model-"))
  const script = path.join(dir, "worker.py")
  let scope: Scope.Scope | undefined
  try {
    await writeFile(script, Buffer.from(await Bun.file(input.asset).arrayBuffer()))
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let errorText = ""
    stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString("utf8")).slice(-4096) })
    const spawned = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AppProcess.Service
        const processScope = yield* Scope.make()
        const stream = Stream.fromAsyncIterable(stdin as AsyncIterable<Uint8Array>, (error) => error as PlatformError.PlatformError)
        const handle = yield* service.spawn({
          command: input.command,
          args: ["-u", script, ...(input.args ?? [])],
          stdin: stream,
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
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    let started = false
    let pending: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | undefined
    let closed = false
    let closing: Promise<void> | undefined
    const onExit = () => { try { process.kill(Number(spawned.handle.pid)) } catch { /* already exited */ } }
    process.once("exit", onExit)
    const fail = (error: Error) => { readyReject(error); pending?.reject(error); pending = undefined }
    const close = (reason = new Error("Computer model worker stopped")) => {
      if (closing) return closing
      closed = true
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
    lines.on("line", (line) => {
      let reply: Record<string, unknown>
      try { reply = JSON.parse(line) as Record<string, unknown> }
      catch { void close(new Error("Computer model worker returned invalid JSON")); return }
      if (!started && typeof reply.ready === "boolean") {
        started = true
        if (reply.ready) readyResolve()
        else { readyReject(new Error(String(reply.error ?? "Computer model worker did not start"))); void close() }
        return
      }
      if (!pending) return
      const request = pending
      pending = undefined
      if (reply.error) request.reject(new Error(String(reply.error)))
      else request.resolve(reply)
    })
    void Effect.runPromise(spawned.handle.exitCode).then(
      (code) => { if (!closed) void close(new Error(errorText.trim() || `Computer model worker exited with ${code}`)) },
      (cause) => { if (!closed) void close(new Error(String(cause))) },
    )
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Computer model worker startup timed out")), input.startupTimeoutMs ?? 45_000) }),
      ])
    } catch (error) { await close(); throw error }
    finally { clearTimeout(startupTimer) }
    let tail: Promise<unknown> = Promise.resolve()
    return {
      request: (value, signal, timeoutMs = 10_000) => {
        const run = () => new Promise<Record<string, unknown>>((resolve, reject) => {
          if (closed) { reject(new Error("Computer model worker stopped")); return }
          if (signal?.aborted) { reject(new Error("Computer model request cancelled")); return }
          const abort = () => { void close(new Error("Computer model request cancelled")) }
          signal?.addEventListener("abort", abort, { once: true })
          const timeout = setTimeout(() => { void close(new Error("Computer model request timed out")) }, timeoutMs)
          pending = {
            resolve: (reply) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); resolve(reply) },
            reject: (error) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error) },
          }
          try { stdin.write(JSON.stringify(value) + "\n") }
          catch (error) { void close(error instanceof Error ? error : new Error(String(error))) }
        })
        const current = tail.then(run, run)
        tail = current.catch(() => undefined)
        return current
      },
      close: () => close(),
      isClosed: () => closed,
    }
  } catch (error) {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export * as ComputerJsonLineWorker from "./json-line-worker"
