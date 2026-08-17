import { spawn } from "bun-pty"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41999
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
async function check() {
  const client = createJyycodeClient({ baseUrl: `http://127.0.0.1:${PORT}`, directory: dir })
  const sessions = (await client.session.list()).data ?? []
  const s = sessions[0]
  if (s) {
    const msgs = (await client.session.messages({ sessionID: s.id })).data ?? []
    console.log(`[check] msgs=${msgs.length} last=${msgs.at(-1)?.info?.role} completed=${msgs.at(-1)?.info?.time?.completed ?? "none"}`)
  }
}
const iv = setInterval(() => void check().catch(() => {}), 8000)
setTimeout(() => {
  clearInterval(iv)
  writeFileSync("C:/Users/35027/AppData/Local/Temp/jyy-userdir2.log", serverLog + "\n===TUI===\n" + tuiBuf)
  try { server.kill() } catch {}; try { tui?.kill() } catch {}; process.exit(0)
}, 40000)
