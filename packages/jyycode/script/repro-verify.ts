import { spawn } from "bun-pty"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const dir = mkdtempSync(join(tmpdir(), "jyy-verify-"))
const bunPath = process.execPath
const outFile = "C:/Users/35027/AppData/Local/Temp/jyy-verify-out.log"
const pty = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "--conditions=browser", "D:/jyycode/packages/jyycode/src/index.ts", dir], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env, JYYCODE_DISABLE_MOUSE: "1", JYYCODE_PWD: dir },
})
let buf = "", sent = false
pty.onData((data) => {
  buf += data
  if (!sent && (buf.includes("Ask anything") || buf.includes("What is the tech stack"))) {
    sent = true
    setTimeout(() => pty.write("reply with exactly OK\r"), 500)
  }
})
setTimeout(() => {
  writeFileSync(outFile, buf)
  console.log("saved", buf.length, "bytes")
  try { pty.kill() } catch {}
  process.exit(0)
}, 45000)
