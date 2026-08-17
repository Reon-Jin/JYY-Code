import { spawn } from "bun-pty"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const dir = mkdtempSync(join(tmpdir(), "jyy-verify-"))
const bunPath = process.execPath
const pty = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "--conditions=browser", "D:/jyycode/packages/jyycode/src/index.ts", dir], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env, JYYCODE_DISABLE_MOUSE: "1", JYYCODE_PWD: dir },
})
let buf = "", sent = false, replyRendered = false
pty.onData((data) => {
  buf += data
  if (!sent && (buf.includes("Ask anything") || buf.includes("What is the tech stack"))) {
    sent = true
    setTimeout(() => pty.write("reply with exactly OK\r"), 500)
  }
})
setTimeout(() => {
  const plain = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
  const okRendered = plain.includes("OK") && !plain.includes("esc interrupt")
  const hasThought = plain.includes("Thought")
  console.log("=== 结果 ===")
  console.log("回复OK渲染:", okRendered, "| Thought:", hasThought, "| 输出字节:", buf.length)
  try { pty.kill() } catch {}
  process.exit(okRendered ? 0 : 1)
}, 45000)
