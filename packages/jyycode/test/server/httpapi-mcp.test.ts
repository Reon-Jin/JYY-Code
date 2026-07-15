import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import * as Log from "@jyycode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Global } from "@jyycode-ai/core/global"
import fs from "fs/promises"
import path from "path"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

function app() {
  return Server.Default().app
}
type TestApp = ReturnType<typeof app>
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const handlerScoped = Effect.acquireRelease(
  Effect.sync(() => HttpApiApp.webHandler()),
  (handler) => Effect.promise(() => handler.dispose()).pipe(Effect.ignore),
)

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-jyycode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

describe("mcp HttpApi", () => {
  it.instance(
    "persists global MCP configuration without disturbing comments or unrelated config",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const configFile = path.join(Global.Path.config, "jyycode.jsonc")
        const authFile = path.join(Global.Path.data, "mcp-auth.json")
        const before = yield* Effect.promise(() => fs.readFile(configFile, "utf8").catch(() => undefined))
        const beforeAuth = yield* Effect.promise(() => fs.readFile(authFile, "utf8").catch(() => undefined))
        const original = `{
  // keep this comment
  "mcp": {
    "old": { "type": "local", "command": ["old"], "enabled": false },
    "keep": { "type": "local", "command": ["keep"], "enabled": false }
  },
  "skills": { "paths": ["/keep/skills"] }
}
`
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (before === undefined) await fs.rm(configFile, { force: true })
            else await fs.writeFile(configFile, before)
            if (beforeAuth === undefined) await fs.rm(authFile, { force: true })
            else await fs.writeFile(authFile, beforeAuth)
          }),
        )
        yield* Effect.promise(() => fs.mkdir(Global.Path.config, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(configFile, original))
        yield* Effect.promise(() => fs.mkdir(Global.Path.data, { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(authFile, JSON.stringify({ old: { tokens: { accessToken: "do-not-log" } } })),
        )

        const remote = { type: "remote", url: "https://mcp.example.test", enabled: true } as const
        const created = yield* request(handler, "/mcp/browser/config", tmp.directory, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(remote),
        })
        expect(created.status).toBe(200)
        expect(yield* json(created)).toEqual(remote)

        const configResponse = yield* request(handler, McpPaths.config, tmp.directory)
        expect(configResponse.status).toBe(200)
        const config = yield* json<Record<string, unknown>>(configResponse)
        expect(config).toMatchObject({ browser: remote, old: expect.any(Object), keep: expect.any(Object) })
        expect(config.projectOnly).toBeUndefined()

        const local = {
          type: "local",
          command: ["bun", "run", "server.ts", "--port", "3000"],
          enabled: false,
        } as const
        const replaced = yield* request(handler, "/mcp/browser/config", tmp.directory, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(local),
        })
        expect(replaced.status).toBe(200)
        expect(yield* json(replaced)).toEqual(local)

        for (const payload of [
          { type: "local", command: [] },
          { type: "remote", url: "not a URL" },
        ]) {
          const invalid = yield* request(handler, "/mcp/invalid/config", tmp.directory, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
          expect(invalid.status).toBe(400)
        }

        const missing = yield* request(handler, "/mcp/missing/config", tmp.directory, { method: "DELETE" })
        expect(missing.status).toBe(404)

        const removed = yield* request(handler, "/mcp/old/config", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toBe(true)

        const source = yield* Effect.promise(() => fs.readFile(configFile, "utf8"))
        expect(source).toContain("// keep this comment")
        expect(source).toContain('"keep"')
        expect(source).toContain('"skills"')
        expect(source).not.toContain('"old"')
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(authFile, "utf8"))).old).toBeUndefined()
      }),
    {
      config: {
        mcp: {
          projectOnly: { type: "local", command: ["project"], enabled: false },
        },
      },
    },
  )

  it.instance(
    "serves status endpoint",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const response = yield* request(handler, McpPaths.status, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves add, connect, and disconnect endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const added = yield* request(handler, McpPaths.status, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "added",
            config: {
              type: "local",
              command: ["echo", "added"],
              enabled: false,
            },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

        const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* json(connected)).toBe(true)

        const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
        expect(disconnected.status).toBe(200)
        expect(yield* json(disconnected)).toBe(true)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves deterministic OAuth endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
        expect(start.status).toBe(400)

        const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
        expect(authenticate.status).toBe(400)

        const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toEqual({ success: true })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const dir = tmp.directory
        const headers = { "x-jyycode-directory": dir }

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const response = yield* readResponse({ app: app(), path, headers })

            expect(response).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns typed not found errors for missing MCP servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        for (const input of [
          { method: "POST", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/auth/authenticate" },
          { method: "POST", route: "/mcp/missing/auth/callback", body: JSON.stringify({ code: "code" }) },
          { method: "DELETE", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/connect" },
          { method: "POST", route: "/mcp/missing/disconnect" },
        ]) {
          const response = yield* request(handler, input.route, tmp.directory, {
            method: input.method,
            headers: input.body ? { "content-type": "application/json" } : undefined,
            body: input.body,
          })

          expect(response.status).toBe(404)
          expect(yield* json(response)).toEqual({
            _tag: "McpServerNotFoundError",
            name: "missing",
            message: "MCP server not found: missing",
          })
        }
      }),
    { config: { mcp: {} } },
  )
})
