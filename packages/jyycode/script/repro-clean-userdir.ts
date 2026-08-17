import { spawn } from "bun-pty"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41990
const dir = "C:/Users/35027"
const server = spawn(bunPath, ["run", "--cwd", "D:/jyycode/packages/jyycode", "dev", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"], {
  cwd: dir, cols: 120, rows: 40, env: { ...process.env },
})
let ready = false
server.onData((data) => {
  if (!ready && data.includes("server listening")) {
    ready = true
    setTimeout(async () => {
      const client = createJyycodeClient({ baseUrl: `http://127.0.0.1:${PORT}`, directory: dir })
      const sessions = (await client.session.list()).data ?? []
      console.log("主目录项目现有会话:", sessions.length)
      for (const s of sessions) {
        await client.session.delete({ sessionID: s.id }).catch((e) => console.log("del fail", s.id, e.message))
      }
      const after = (await client.session.list()).data ?? []
      console.log("删除后会话:", after.length)
      try { server.kill() } catch {}
      process.exit(0)
    }, 2000)
  }
})
setTimeout(() => { try { server.kill() } catch {}; process.exit(0) }, 30000)
