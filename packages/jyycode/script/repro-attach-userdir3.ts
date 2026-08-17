import { spawn } from "bun-pty"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41991
const dir = "C:/Users/35027"
const server = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "dev", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env },
})
let ready = false
let tui, tuiBuf = "", sent = false
server.onData((data) => {
  if (!ready && data.includes("server listening")) { ready = true; setTimeout(startTui, 1500) }
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
async function check() {
  const client = createJyycodeClient({ baseUrl: `http://127.0.0.1:${PORT}`, directory: dir })
  const sessions = (await client.session.list()).data ?? []
  const s = sessions[0]
  if (s) {
    const msgs = (await client.session.messages({ sessionID: s.id })).data ?? []
    const last = msgs.at(-1)
    console.log(`[check] msgs=${msgs.length} last=${last?.info?.role} completed=${last?.info?.time?.completed ?? "none"}`)
    if (last?.info?.time?.completed) { try { server.kill() } catch {}; try { tui?.kill() } catch {}; process.exit(0) }
  }
}
const iv = setInterval(() => void check().catch(() => {}), 5000)
setTimeout(() => { clearInterval(iv); try { server.kill() } catch {}; try { tui?.kill() } catch {}; process.exit(0) }, 40000)
