import { spawn } from "bun-pty"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
const bunPath = process.execPath
const PORT = 41993
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
      const created = await client.session.create({})
      const sessionID = created.data?.id
      console.log("[sdk] session:", sessionID)
      const res = await client.session.promptAsync({
        sessionID,
        body: { parts: [{ type: "text", text: "reply with exactly OK" }] },
      })
      console.log("[sdk] promptAsync:", JSON.stringify(res).slice(0, 400))
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const msgs = (await client.session.messages({ sessionID })).data ?? []
        const last = msgs.at(-1)
        const completed = last?.info?.time?.completed
        console.log(`[sdk-poll] msgs=${msgs.length} last=${last?.info?.role} completed=${completed ?? "none"}`)
        if (completed) break
        await Bun.sleep(3000)
      }
      try { server.kill() } catch {}
      process.exit(0)
    }, 1500)
  }
})
setTimeout(() => { try { server.kill() } catch {}; process.exit(0) }, 45000)
