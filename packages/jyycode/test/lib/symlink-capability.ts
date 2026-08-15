import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Windows requires Developer Mode or an elevated token for file symlinks.
 * Keep symlink-specific tests visible as skipped when this capability is not
 * available instead of reporting an unrelated product failure.
 */
export const symlinkAvailable = await (async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jyycode-symlink-capability-"))
  const target = path.join(root, "target")
  const link = path.join(root, "link")
  try {
    await fs.writeFile(target, "target")
    await fs.symlink(target, link, "file")
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return false
    throw error
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})()
