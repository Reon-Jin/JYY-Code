import { spawn } from "bun-pty"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41997
const dir = "C:/Users/35027"
const server = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "dev", "--print-logs", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env },
})
let serverLog = "", serverReady = false
let tui, tuiBuf = "", sent = false
server.onData((data) => {
  serverLog += data
  if (!serverReady && data.includes("server listening")) { serverReady = true; setTimeout(startTui, 1500) }
})
function startTui() {
  tui = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "dev", "attach", `http://127.0.0.1:${PORT}`, "--dir", dir], {
    cwd: dir, cols: 120, rows: 40, env: { ...process.env, JYYCODE_DISABLE_MOUSE: "1" },
  })
  tui.onData((data) => {
    tuiBuf += data
    if (!sent && (tuiBuf.includes("Ask anything") || tuiBuf.includes("What is the tech stack"))) {
      sent = true
      setTimeout(() => tui.write("reply with exactly OK\r"), 500)
    }
  })
}
const { writeFileSync } = require("node:fs")
setTimeout(() => {
  writeFileSync("C:/Users/35027/AppData/Local/Temp/jyy-serverlog.txt", serverLog)
  console.log("server log saved, len:", serverLog.length)
  try { server.kill() } catch {}; try { tui?.kill() } catch {}; process.exit(0)
}, 50000)
