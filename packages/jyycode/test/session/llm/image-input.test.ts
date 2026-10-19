import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { ModelMessage } from "ai"
import { Image } from "../../../src/image/image"
import { LLMImageInput } from "../../../src/session/llm/image-input"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

const it = testEffect(Image.layer.pipe(Layer.provide(TestConfig.layer())))
const part = (input: { mime: string; url: string }) => ({
  ...input,
  type: "file" as const,
  id: PartID.ascending(),
  messageID: MessageID.ascending(),
  sessionID: SessionID.make("ses_image_normalize"),
})

describe("outbound images", () => {
  it.effect("normalizes binary image data and corrects a mismatched MIME without fetching remote images", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(16).fill(255), 2, 2)
      const bytes = source.get_bytes()
      source.free()
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/jpeg",
              data: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
            },
            { type: "image", image: bytes },
            { type: "image", image: new URL("https://example.com/image.png") },
          ],
        },
      ]
      let calls = 0
      const prepared = yield* LLMImageInput.prepareImages(messages, (input) => {
        calls++
        return image.normalize(part(input))
      })
      const user = prepared[0]!
      if (user.role !== "user" || !Array.isArray(user.content)) throw new Error("user content lost")
      expect(calls).toBe(2)
      expect(user.content[0]).toMatchObject({
        type: "file",
        mediaType: "image/png",
        data: expect.stringContaining("data:image/png;"),
      })
      expect(user.content[1]).toMatchObject({
        type: "image",
        mediaType: "image/png",
        image: expect.stringContaining("data:image/png;"),
      })
      expect(user.content[2]).toMatchObject({ type: "image", image: new URL("https://example.com/image.png") })
    }),
  )

  it.effect("normalizes a valid 195x11000 tool screenshot without changing its original bytes", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(195 * 11000 * 4).fill(255), 195, 11000)
      const original = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "read", toolName: "read", input: { filePath: "m-full.png" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "read",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "media", mediaType: "image/png", data: original },
                ],
              },
            },
          ],
        },
      ]
      const prepared = yield* LLMImageInput.prepareImages(messages, (input) =>
        image.normalize(part(input), { maxWidth: 8192, maxHeight: 8192 }),
      )
      const tool = prepared[1]!
      if (tool.role !== "tool" || tool.content[0]?.type !== "tool-result" || tool.content[0].output.type !== "content")
        throw new Error("tool result lost")
      const media = tool.content[0].output.value[1]!
      if (media.type !== "media") throw new Error("image lost")
      const bytes = Buffer.from(media.data, "base64")
      expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(8192)
      expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(140)
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
      expect(prepared[0]).toEqual(messages[0])
      expect(JSON.stringify(messages)).toContain(original)
      expect(JSON.stringify(prepared)).not.toContain(original)
    }),
  )

  it.effect("preserves text, PDFs and tool identities when omitting all image representations", () =>
    Effect.gen(function* () {
      const url = "data:image/png;base64,aW1hZ2U="
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Review the webpage" },
            { type: "image", image: url },
            { type: "file", mediaType: "image/png", data: url },
            { type: "file", mediaType: "application/pdf", data: "cGRm" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-read",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "image-data", mediaType: "image/png", data: "aW1hZ2U=" },
                  { type: "image-url", url: "https://example.com/image.png" },
                  { type: "image-file-id", fileId: "file-img" },
                  { type: "file-data", mediaType: "application/pdf", data: "cGRm" },
                  { type: "text", text: "Existing result" },
                ],
              },
            },
          ],
        },
      ]
      const prepared = yield* LLMImageInput.prepareImages(
        messages,
        () => Effect.die("must not decode during fallback"),
        true,
      )
      expect(LLMImageInput.hasImages(prepared)).toBe(false)
      const text = JSON.stringify(prepared)
      expect(text).toContain("Original files are preserved")
      expect(text).toContain("Existing result")
      expect(text).toContain("call-read")
      expect(text).toContain("cGRm")
      expect(text).not.toContain("aW1hZ2U=")
      expect(LLMImageInput.hasImages(messages)).toBe(true)
    }),
  )

  it.effect("turns a corrupt image into an honest placeholder while preserving other content", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const prepared = yield* LLMImageInput.prepareImages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "Continue coding" },
              { type: "image", image: "data:image/png;base64,bm90IGFuIGltYWdl" },
            ],
          },
        ],
        (input) => image.normalize(part(input)),
      )
      expect(LLMImageInput.hasImages(prepared)).toBe(false)
      expect(JSON.stringify(prepared)).toContain("could not be viewed")
      expect(JSON.stringify(prepared)).toContain("Continue coding")
    }),
  )

  test("recognizes image validation failures without treating balance or transient errors as image rejection", () => {
    const error = { statusCode: 400, message: ".messages[114].image[0]: You have uploaded an unsupported image" }
    expect(LLMImageInput.isImageInputError(error)).toBe(true)
    expect(LLMImageInput.isImageInputError({ data: error })).toBe(true)
    expect(LLMImageInput.isImageInputError({ statusCode: 422, message: "Invalid base64 image_url" })).toBe(true)
    expect(LLMImageInput.isImageInputError({ statusCode: 402, message: "Insufficient Balance" })).toBe(false)
    expect(LLMImageInput.isImageInputError({ statusCode: 429, message: "image requests rate limit" })).toBe(false)
    expect(LLMImageInput.isImageInputError({ statusCode: 500, message: "unsupported image server error" })).toBe(false)
    expect(LLMImageInput.isImageInputError(new Error("Aborted"))).toBe(false)
  })
})
