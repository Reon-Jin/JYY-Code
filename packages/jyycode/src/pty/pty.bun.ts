import { spawn as create } from "bun-pty"
import { killProcessTreeVerified } from "@jyycode-ai/core/process-supervisor"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty = create(file, args, opts)
  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      return pty.onExit(listener)
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      try {
        pty.kill(signal)
      } catch {}
      return killProcessTreeVerified(pty.pid, { signal: signal as NodeJS.Signals | undefined })
    },
  }
}
