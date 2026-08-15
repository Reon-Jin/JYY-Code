import { execFileSync } from "node:child_process"

/**
 * Synchronous Git adapter for snapshot manifests and three-way merge scans.
 *
 * Those APIs are deliberately synchronous because they run inside pure
 * planning/merge transactions. Keep the native boundary in this file only;
 * interactive and runtime subprocesses use AppProcess.Service.
 */
export function execGitSync(root: string, args: readonly string[]) {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  })
}

export function tryExecGitSync(root: string, args: readonly string[]) {
  try {
    return execGitSync(root, args).toString("utf8")
  } catch {
    return undefined
  }
}
