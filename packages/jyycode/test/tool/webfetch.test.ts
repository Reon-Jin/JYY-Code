import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool, resolveWebFetchTimeout } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { ContentLimits } from "../../src/tool/content-limits"
import { assertUrlAllowed } from "../../src/tool/url-policy"

const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const execWithContext = Effect.fn("WebFetchToolTest.execWithContext")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  next: Tool.Context,
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})
const exec = (args: Tool.InferParameters<typeof WebFetchTool>) => execWithContext(args, ctx)

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("bounds chunked responses without relying on Content-Length", () =>
    withFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(ContentLimits.webResponseBytes))
              controller.enqueue(new Uint8Array(1))
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: new URL("/chunked.txt", url).toString(), format: "text" }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("content limit")
        }),
    ),
  )

  it.instance("rejects an oversized response even with a misleading Content-Length", () =>
    withFetch(
      () =>
        new Response(new Uint8Array(ContentLimits.webResponseBytes + 1), {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "1" },
        }),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: new URL("/false-length.txt", url).toString(), format: "text" }).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("content limit")
        }),
    ),
  )

  describe("webfetch timeout resolution (milliseconds)", () => {
    test("defaults to 30000ms when omitted", () => {
      expect(resolveWebFetchTimeout()).toBe(30_000)
    })

    test("interprets the value as milliseconds, capped at 120000", () => {
      expect(resolveWebFetchTimeout(3_000)).toBe(3_000)
      expect(resolveWebFetchTimeout(150_000)).toBe(120_000)
    })

    test("rejects non-positive and non-finite values", () => {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => resolveWebFetchTimeout(value)).toThrow(/milliseconds/)
      }
    })
  })

  it.instance("rejects non-positive and non-finite timeouts before asking for permission", () =>
    Effect.gen(function* () {
      for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const exit = yield* exec({ url: "https://example.com", format: "text", timeout }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("timeout")
      }
    }),
  )

  it.instance("blocks loopback, private, link-local, metadata, and local IPv6 addresses", () =>
    Effect.gen(function* () {
      const hosts = [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "[::1]",
        "[fc00::1]",
        "[fe80::1]",
        "[::ffff:127.0.0.1]",
        "2130706433",
        "0x7f000001",
      ]

      for (const host of hosts) {
        const exit = yield* Effect.tryPromise(() =>
          assertUrlAllowed(`http://${host}/`, { resolve: async () => [new URL(`http://${host}/`).hostname] }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }),
  )

  it.instance("rejects DNS results when any resolved address is private", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.tryPromise(() =>
        assertUrlAllowed("https://mixed.example/", {
          resolve: async () => ["93.184.216.34", "10.0.0.8"],
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rechecks the URL policy before following a redirect", () =>
    withFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/private" } }),
      (url) =>
        Effect.gen(function* () {
          let privateRequests = 0
          const next: Tool.Context = {
            ...ctx,
            ask: (request) => {
              if (request.permission === "network_private") {
                privateRequests++
                if (privateRequests > 1) return Effect.die(new Error("private origin denied"))
              }
              return Effect.void
            },
          }
          const exit = yield* execWithContext(
            { url: new URL("/redirect", url).toString(), format: "text" },
            next,
          ).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(privateRequests).toBe(2)
        }),
    ),
  )

  it.instance("caps redirect chains at five hops", () =>
    withFetch(
      (request) => {
        const hop = Number(new URL(request.url).searchParams.get("hop") ?? "0")
        return new Response(null, {
          status: 302,
          headers: { location: `/redirect?hop=${hop + 1}` },
        })
      },
      (url) =>
        Effect.gen(function* () {
          const exit = yield* exec({ url: new URL("/redirect?hop=0", url).toString(), format: "text" }).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Too many redirects")
        }),
    ),
  )
})
