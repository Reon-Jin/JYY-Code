import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createJyycodeClient } from "@jyycode-ai/sdk/v2"
import { testProviderConfig } from "../lib/test-provider"

const packageDir = path.resolve(import.meta.dir, "../..")
let running: { kill: () => void; exited: Promise<number> } | undefined

const stopRunning = async () => {
  const current = running
  if (!current) return
  running = undefined
  current.kill()
  await current.exited
}

async function builtCliPath() {
  const explicit = process.env.JYYCODE_BUILT_CLI
  if (explicit) return path.resolve(explicit)
  const matches = await Array.fromAsync(new Bun.Glob("dist/**/bin/jyycode*").scan({ cwd: packageDir }))
  const current = matches.find((item) => !item.endsWith(".map"))
  if (!current) throw new Error("built CLI artifact missing; run packages/jyycode build --single --skip-install")
  return path.join(packageDir, current)
}

function fakeLlm() {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = [
        `data: ${JSON.stringify({ id: "built-smoke", choices: [{ delta: { role: "assistant" } }] })}`,
        `data: ${JSON.stringify({ id: "built-smoke", choices: [{ delta: { content: "built prompt ok" } }] })}`,
        `data: ${JSON.stringify({ id: "built-smoke", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
}

afterEach(async () => {
  await stopRunning()
})

describe("built HTTP server", () => {
  test("serves health and completes a text prompt through the built entrypoint", async () => {
    const binary = await builtCliPath()
    const llm = fakeLlm()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-built-http-"))
    try {
      const env = {
        ...process.env,
        JYYCODE_TEST_HOME: home,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        JYYCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(`http://127.0.0.1:${llm.port}/v1`)),
        JYYCODE_DISABLE_PROJECT_CONFIG: "1",
        JYYCODE_PURE: "1",
        JYYCODE_DISABLE_MODELS_FETCH: "1",
        JYYCODE_AUTH_CONTENT: "{}",
      }
      const child = Bun.spawn(
        [binary, "--print-logs", "--log-level", "DEBUG", "serve", "--port", "0", "--hostname", "127.0.0.1", "--json"],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      running = { kill: () => child.kill(), exited: child.exited }
      const reader = child.stdout.getReader()
      const stderrPromise = new Response(child.stderr).text()
      const decoder = new TextDecoder()
      let output = ""
      let ready: { port: number } | undefined
      const deadline = Date.now() + 30_000
      while (!ready && Date.now() < deadline) {
        const next = await reader.read()
        if (next.done) break
        output += decoder.decode(next.value)
        for (const line of output.split(/\r?\n/)) {
          try {
            const value = JSON.parse(line) as { type?: string; port?: number }
            if (value.type === "server.ready" && typeof value.port === "number") ready = { port: value.port }
          } catch {
            // The server may emit migration progress before the ready JSON.
          }
        }
      }
      if (!ready) throw new Error(`built server did not become ready: ${output}`)
      const baseUrl = `http://127.0.0.1:${ready.port}`
      const health = await fetch(`${baseUrl}/global/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ healthy: true })

      const sdk = createJyycodeClient({ baseUrl, directory: home })
      const session = await sdk.session.create({ title: "built smoke" })
      expect(session.error).toBeUndefined()
      const prompt = await sdk.session.prompt({
        sessionID: session.data!.id,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello built server" }],
      })
      if (prompt.error) {
        child.kill()
        throw new Error(`${JSON.stringify(prompt.error)}\nserver stderr:\n${await stderrPromise}`)
      }
      expect(prompt.data).toBeDefined()
    } finally {
      await stopRunning()
      await llm.stop()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
