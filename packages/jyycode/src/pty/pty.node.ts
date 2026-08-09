/** @ts-expect-error */
import * as pty from "@lydell/node-pty"
import { killProcessTreeVerified } from "@jyycode-ai/core/process-supervisor"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const proc = pty.spawn(file, args, opts)
  return {
    pid: proc.pid,
    onData(listener) {
      return proc.onData(listener)
    },
    onExit(listener) {
      return proc.onExit(listener)
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      try {
        proc.kill(signal)
      } catch {}
      return killProcessTreeVerified(proc.pid, { signal: signal as NodeJS.Signals | undefined })
    },
  }
}
