#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"

type RunningServer = {
  process: ReturnType<typeof Bun.spawn>
  stdout: Promise<string>
  stderr: Promise<string>
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const smokeModel = { providerID: "persistence-smoke", modelID: "test-model" }
const smokeUsername = "jyycode"
const smokePassword = "persistence-smoke-password"

function smokeAuthHeaders(init?: HeadersInit) {
  const headers = new Headers(init)
  headers.set("Authorization", `Basic ${Buffer.from(`${smokeUsername}:${smokePassword}`).toString("base64")}`)
  return headers
}
const smokeConfig = JSON.stringify({
  model: `${smokeModel.providerID}/${smokeModel.modelID}`,
  provider: {
    [smokeModel.providerID]: {
      name: "Persistence Smoke Test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        [smokeModel.modelID]: {
          name: "Persistence Smoke Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: false,
          limit: { context: 1_000, output: 100 },
          cost: { input: 0, output: 0 },
        },
      },
      options: { apiKey: "unused", baseURL: "http://127.0.0.1" },
    },
  },
})

function defaultBinary() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const base = path.resolve(import.meta.dirname, `../dist/jyycode-${platform}-${process.arch}/bin/jyycode`)
  const candidates = process.platform === "win32" ? [`${base}.exe`, base] : [base]
  const binary = candidates.find(existsSync)
  if (!binary) throw new Error(`Built binary not found. Checked: ${candidates.join(", ")}`)
  return binary
}

async function freePort() {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") })
  const port = server.port
  await server.stop(true)
  return port
}

async function startServer(input: { binary: string; database: string; directory: string }) {
  const port = await freePort()
  const child = Bun.spawn(
    [
      input.binary,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--pure",
      "--print-logs",
      "--log-level",
      "DEBUG",
    ],
    {
      cwd: input.directory,
      env: {
        ...process.env,
        JYYCODE_DB: input.database,
        JYYCODE_CONFIG_DIR: path.join(path.dirname(input.database), "config"),
        JYYCODE_CONFIG_CONTENT: smokeConfig,
        JYYCODE_AUTH_CONTENT: "{}",
        JYYCODE_SERVER_USERNAME: smokeUsername,
        JYYCODE_SERVER_PASSWORD: smokePassword,
        JYYCODE_DISABLE_AUTOUPDATE: "1",
        JYYCODE_DISABLE_MODELS_FETCH: "1",
        JYYCODE_DISABLE_PROJECT_CONFIG: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const running: RunningServer = {
    process: child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  }
  const baseUrl = `http://127.0.0.1:${port}`

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await Promise.race([child.exited.then(() => true), sleep(50).then(() => false)])) {
      const [stdout, stderr] = await Promise.all([running.stdout, running.stderr])
      throw new Error(`Server exited before becoming ready.\n${stdout}\n${stderr}`)
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: smokeAuthHeaders(),
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return { ...running, baseUrl }
    } catch {
      // The listener is still starting.
    }
    await sleep(50)
  }

  await stopServer(running, baseUrl).catch(() => undefined)
  const [stdout, stderr] = await Promise.all([running.stdout, running.stderr])
  throw new Error(`Timed out waiting for server readiness.\n${stdout}\n${stderr}`)
}

async function stopServer(server: RunningServer, baseUrl: string) {
  console.log(`disposing ${baseUrl}`)
  await fetch(`${baseUrl}/global/dispose`, {
    method: "POST",
    headers: smokeAuthHeaders(),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  console.log(`stopping ${baseUrl}`)
  server.process.kill("SIGTERM")
  if (process.platform === "win32") {
    // Bun's Windows signal shim can resolve `exited` before the native process
    // releases its executable. The HTTP dispose above performs graceful
    // resource cleanup; taskkill guarantees the test process cannot leak.
    await Bun.spawn(["taskkill", "/PID", String(server.process.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
    await Promise.race([server.process.exited, sleep(2_000)])
    return
  }

  const exited = await Promise.race([server.process.exited.then(() => true), sleep(5_000).then(() => false)])
  if (!exited) {
    server.process.kill("SIGKILL")
    await server.process.exited
    throw new Error("Server did not exit within 5 seconds after graceful disposal")
  }
  if (processAlive(server.process.pid)) throw new Error(`Server process ${server.process.pid} is still running`)
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    ...init,
    headers: smokeAuthHeaders(init?.headers),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed (${response.status}): ${text}`)
  return JSON.parse(text) as T
}

export async function runSessionPersistenceSmoke(
  binary = process.argv[2] ? path.resolve(process.argv[2]) : defaultBinary(),
) {
  if (!existsSync(binary)) throw new Error(`Built binary not found: ${binary}`)

  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-session-persistence-"))
  const database = path.join(root, "persistence.db")
  const directory = path.join(root, "workspace")
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(path.join(root, "config"), { recursive: true })])
  const query = `directory=${encodeURIComponent(directory)}`
  let first: Awaited<ReturnType<typeof startServer>> | undefined
  let second: Awaited<ReturnType<typeof startServer>> | undefined

  try {
    first = await startServer({ binary, database, directory })
    console.log("first server ready")
    const session = await requestJson<{ id: string; title: string }>(`${first.baseUrl}/session?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "packaged persistence smoke" }),
    })
    await requestJson(`${first.baseUrl}/session/${session.id}/message?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: smokeModel,
        noReply: true,
        parts: [{ type: "text", text: "persist this message" }],
      }),
    })
    console.log("session and message created")
    await stopServer(first, first.baseUrl)
    first = undefined

    second = await startServer({ binary, database, directory })
    console.log("second server ready")
    const reloaded = await requestJson<{ id: string; title: string }>(
      `${second.baseUrl}/session/${session.id}?${query}`,
    )
    const messages = await requestJson<
      Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
    >(`${second.baseUrl}/session/${session.id}/message?${query}`)
    if (reloaded.id !== session.id || reloaded.title !== "packaged persistence smoke") {
      throw new Error(`Reloaded session did not match the created session: ${JSON.stringify(reloaded)}`)
    }
    if (
      !messages.some(
        (message) => message.info.role === "user" && message.parts.some((part) => part.text === "persist this message"),
      )
    ) {
      throw new Error("Reloaded session did not contain the persisted user message")
    }
    await stopServer(second, second.baseUrl)
    second = undefined
    console.log("second server stopped")

    const sqlite = new Database(database, { readonly: true })
    try {
      const sessionCount = sqlite
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM session WHERE id = ?")
        .get(session.id)?.count
      const messageCount = sqlite
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM message WHERE session_id = ?")
        .get(session.id)?.count
      if (sessionCount !== 1 || !messageCount) {
        throw new Error(`Rows were missing after final shutdown: session=${sessionCount}, message=${messageCount ?? 0}`)
      }
    } finally {
      sqlite.close()
    }

    console.log("session persisted")
  } catch (error) {
    const active = second ?? first
    if (!active) throw error
    await stopServer(active, active.baseUrl).catch(() => active.process.kill("SIGKILL"))
    if (active === first) first = undefined
    if (active === second) second = undefined
    const [stdout, stderr] = await Promise.all([active.stdout, active.stderr])
    throw new Error(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${stdout}\n${stderr}`)
  } finally {
    if (first) await stopServer(first, first.baseUrl).catch(() => first?.process.kill("SIGKILL"))
    if (second) await stopServer(second, second.baseUrl).catch(() => second?.process.kill("SIGKILL"))
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await runSessionPersistenceSmoke()
}
