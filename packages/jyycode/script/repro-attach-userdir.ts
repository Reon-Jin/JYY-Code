import { spawn } from "bun-pty"
import { writeFileSync } from "node:fs"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41996
const dir = "C:/Users/35027"
const outFile = "C:/Users/35027/AppData/Local/Temp/jyy-attach-userdir.log"

const server = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "dev", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env },
})
let serverReady = false
let tui, tuiBuf = "", sent = false
server.onData((data) => {
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
  tui.onExit(() => process.exit(0))
}
async function checkBackend(tag: string) {
  try {
    const client = createJyycodeClient({ baseUrl: `http://127.0.0.1:${PORT}`, directory: dir })
    const sessions = (await client.session.list()).data ?? []
    for (const s of sessions.slice(0, 1)) {
      const msgs = (await client.session.messages({ sessionID: s.id })).data ?? []
      const last = msgs[msgs.length - 1]
      console.log(`[${tag}] session=${s.title} msgs=${msgs.length} last=${last?.info?.role} completed=${last?.info?.time?.completed ?? "none"}`)
    }
  } catch (e) { console.log(`[${tag}] err:`, e instanceof Error ? e.message : e) }
}
const iv = setInterval(() => void checkBackend("poll"), 10000)
setTimeout(() => {
  clearInterval(iv)
  writeFileSync(outFile, tuiBuf)
  void checkBackend("final").finally(() => {
    try { server.kill() } catch {}; try { tui?.kill() } catch {}; process.exit(0)
  })
}, 55000)
