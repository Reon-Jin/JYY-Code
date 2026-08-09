import { Effect, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { ContentLimitError, ContentLimits, readBoundedBytes } from "./content-limits"
import { assertUrlAllowedEffect, UrlPolicyError } from "./url-policy"

const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "web",
        mutability: "external",
        risk: "medium",
        detail: "standard",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const timeoutSeconds = params.timeout ?? DEFAULT_TIMEOUT / 1000
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
            throw new Tool.InvalidArgumentsError({
              tool: "webfetch",
              detail: "timeout must be a finite positive number of seconds",
            })
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min(timeoutSeconds * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const authorizeUrl = (input: string) =>
            assertUrlAllowedEffect(input).pipe(
              Effect.catchIf(
                (error) => error instanceof UrlPolicyError && Boolean(error.address),
                (error) =>
                  ctx
                    .ask({
                      permission: "network_private",
                      patterns: [new URL(input).origin],
                      always: [new URL(input).origin],
                      metadata: { url: input, address: error.address },
                    })
                    .pipe(Effect.andThen(assertUrlAllowedEffect(input, { allowPrivate: true }))),
              ),
            )

          const executeRequest = (input: string, requestHeaders: Record<string, string>) =>
            http
              .execute(HttpClientRequest.get(input).pipe(HttpClientRequest.setHeaders(requestHeaders)))
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))

          const fetched = yield* Effect.gen(function* () {
            let current = params.url
            for (let redirects = 0; ; redirects++) {
              const currentUrl = yield* authorizeUrl(current)
              let response = yield* executeRequest(currentUrl.toString(), headers)

              // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch).
              if (response.status === 403 && response.headers["cf-mitigated"] === "challenge") {
                response = yield* executeRequest(currentUrl.toString(), { ...headers, "User-Agent": "jyycode" })
              }

              if (response.status >= 300 && response.status < 400) {
                if (redirects >= 5) throw new Error("Too many redirects (maximum 5)")
                const location = response.headers["location"]
                if (!location) throw new Error("Redirect response did not include a Location header")
                yield* response.stream.pipe(Stream.runDrain).pipe(Effect.ignore)
                current = new URL(location, currentUrl).toString()
                continue
              }

              if (response.status < 200 || response.status >= 300) {
                throw new Error(`Request failed with status ${response.status}`)
              }

              return { response, currentUrl }
            }
          }).pipe(
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          const { response, currentUrl } = fetched

          // Reject declared oversize bodies before opening the response stream.
          const contentLength = response.headers["content-length"]
          const declaredLength = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN
          if (Number.isFinite(declaredLength) && declaredLength > ContentLimits.webResponseBytes) {
            throw new ContentLimitError({
              resource: "web response",
              limit: ContentLimits.webResponseBytes,
              actual: declaredLength,
            })
          }

          const bytes = yield* readBoundedBytes(response.stream, ContentLimits.webResponseBytes, "web response")

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${currentUrl} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(bytes).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(bytes)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
