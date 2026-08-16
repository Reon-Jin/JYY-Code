import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

export type TerminationState = "exited" | "killed" | "kill_failed"

export type TerminationResult = {
  readonly state: TerminationState
  readonly pid: number
  readonly remainingPids: readonly number[]
  readonly signal?: NodeJS.Signals
  readonly error?: string
  /** True when Windows used the development taskkill fallback without the guardian artifact. */
  readonly degraded?: boolean
}

export class ProcessTerminationError extends Error {
  readonly code = "PROCESS_TERMINATION_FAILED"
  readonly result: TerminationResult

  constructor(result: TerminationResult) {
    super(`failed to verify process-tree termination for PID ${result.pid}`)
    this.name = "ProcessTerminationError"
    this.result = result
  }
}

export type TerminationOptions = {
  readonly graceMs?: number
  readonly verifyMs?: number
  readonly pollMs?: number
  readonly signal?: NodeJS.Signals
  readonly killSignal?: NodeJS.Signals
  /** Test hook; production callers use the real process platform. */
  readonly platform?: NodeJS.Platform
}

type ProcessRecord = { readonly pid: number; readonly ppid: number; readonly pgid?: number }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

export function isProcessAlive(pid: number): boolean {
  if (!validPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ESRCH"
  }
}

async function processRecords(platform: NodeJS.Platform): Promise<readonly ProcessRecord[]> {
  if (platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"
    try {
      const result = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })
      const parsed: unknown = JSON.parse(result.stdout.trim() || "[]")
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return []
        const value = row as { ProcessId?: unknown; ParentProcessId?: unknown }
        const pid = Number(value.ProcessId)
        const ppid = Number(value.ParentProcessId)
        return validPid(pid) && validPid(ppid) ? [{ pid, ppid }] : []
      })
    } catch {
      return []
    }
  }
  try {
    const result = await execFile("ps", ["-eo", "pid=,ppid=,pgid="], { maxBuffer: 2 * 1024 * 1024 })
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
      if (!match) return []
      const pid = Number(match[1])
      const ppid = Number(match[2])
      const pgid = Number(match[3])
      return validPid(pid) && validPid(ppid) && validPid(pgid) ? [{ pid, ppid, pgid }] : []
    })
  } catch {
    return []
  }
}

function isProcessGroupAlive(pid: number, platform: NodeJS.Platform): boolean {
  if (platform === "win32" || !validPid(pid)) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM"
  }
}

export async function listProcessTreePids(pid: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (!validPid(pid)) return []
  const rows = await processRecords(platform)
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const result: number[] = []
  const pending = [pid]
  const seen = new Set<number>()
  while (pending.length > 0) {
    const current = pending.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    if (isProcessAlive(current)) result.push(current)
    pending.push(...(children.get(current) ?? []))
  }
  return result
}

export async function listProcessGroupPids(pid: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (platform === "win32" || !validPid(pid)) return []
  const rows = await processRecords(platform)
  return rows.filter((row) => row.pgid === pid && isProcessAlive(row.pid)).map((row) => row.pid)
}

async function activeProcessPids(pid: number, platform: NodeJS.Platform): Promise<number[]> {
  const tree = await listProcessTreePids(pid, platform)
  const group = await listProcessGroupPids(pid, platform)
  return [...new Set([...tree, ...group])]
}

async function waitUntilDead(pid: number, originalTree: readonly number[], platform: NodeJS.Platform, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    const current = await activeProcessPids(pid, platform)
    if (current.length === 0 && originalTree.every((item) => !isProcessAlive(item))) return true
    if (Date.now() >= deadline) break
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  } while (Date.now() <= deadline)
  const current = await activeProcessPids(pid, platform)
  return current.length === 0 && originalTree.every((item) => !isProcessAlive(item))
}

async function windowsKill(pid: number): Promise<{ degraded: boolean }> {
  if (process.env.JYYCODE_RELEASE === "1" && !process.env.JYYCODE_PROCESS_GUARDIAN) {
    throw new Error("PROCESS_GUARDIAN_MISSING")
  }
  await execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true })
  return { degraded: !process.env.JYYCODE_PROCESS_GUARDIAN }
}

/**
 * Terminate a process and verify that the process leader is gone. Unix callers
 * are expected to spawn a detached process group, so negative-PID signals
 * cover descendants. Windows uses taskkill's tree mode; a failed verification
 * is reported as `kill_failed`, never as a successful timeout.
 */
export async function terminateProcessTree(pid: number, options: TerminationOptions = {}): Promise<TerminationResult> {
  const platform = options.platform ?? process.platform
  const graceMs = options.graceMs ?? 3000
  const verifyMs = options.verifyMs ?? 3000
  const pollMs = options.pollMs ?? 25
  const signal = options.signal ?? "SIGTERM"
  const killSignal = options.killSignal ?? "SIGKILL"
  let degraded = false

  if (!validPid(pid)) return { state: "exited", pid, remainingPids: [] }
  const leaderAlive = isProcessAlive(pid)
  const groupAlive = isProcessGroupAlive(pid, platform)
  if (!leaderAlive && !groupAlive) return { state: "exited", pid, remainingPids: [] }
  const originalTree = leaderAlive ? await activeProcessPids(pid, platform) : []

  const send = async (next: NodeJS.Signals) => {
    if (platform === "win32") {
      degraded = (await windowsKill(pid)).degraded
      return
    }
    try {
      if (groupAlive) process.kill(-pid, next)
      else process.kill(pid, next)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ESRCH") {
        // A process may have been spawned without its own process group.  The
        // negative-PID group signal is then harmless but does not terminate
        // the leader, so fall back to addressing the leader directly.
        try {
          process.kill(pid, next)
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError
        }
        return
      }
      // A process not created as a group leader can still be terminated by PID.
      // EPERM is deliberately not downgraded: it means termination was not
      // confirmed and must surface as kill_failed to the caller.
      if (code === "EINVAL") process.kill(pid, next)
      else throw error
    }
  }

  try {
    await send(signal)
    if (await waitUntilDead(pid, originalTree, platform, graceMs, pollMs))
      return { state: "killed", pid, remainingPids: [], signal, ...(degraded ? { degraded: true } : {}) }
    await send(killSignal)
  } catch (error) {
    const dead = await waitUntilDead(pid, originalTree, platform, verifyMs, pollMs)
    if (dead) return { state: "exited", pid, remainingPids: [], ...(degraded ? { degraded: true } : {}) }
    return {
      state: "kill_failed",
      pid,
      remainingPids: [pid],
      signal,
      error: error instanceof Error ? error.message : String(error),
      ...(degraded ? { degraded: true } : {}),
    }
  }

  if (await waitUntilDead(pid, originalTree, platform, verifyMs, pollMs))
    return { state: "killed", pid, remainingPids: [], signal: killSignal, ...(degraded ? { degraded: true } : {}) }
  const remaining = (await activeProcessPids(pid, platform)).length > 0
    ? await activeProcessPids(pid, platform)
    : originalTree.filter(isProcessAlive)
  return { state: "kill_failed", pid, remainingPids: remaining, signal: killSignal, ...(degraded ? { degraded: true } : {}) }
}

export async function killProcessTreeVerified(pid: number, options: TerminationOptions = {}): Promise<TerminationResult> {
  const result = await terminateProcessTree(pid, options)
  if (result.state === "kill_failed") throw new ProcessTerminationError(result)
  return result
}

export async function assertProcessTreeStopped(pid: number, options: Omit<TerminationOptions, "signal" | "killSignal"> = {}) {
  if (isProcessAlive(pid)) {
    const result = await terminateProcessTree(pid, options)
    if (result.state === "kill_failed") throw new ProcessTerminationError(result)
    return result
  }
  return { state: "exited", pid, remainingPids: [] } satisfies TerminationResult
}
