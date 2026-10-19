import type { DataContent, ImagePart, FilePart, ModelMessage, ToolResultPart } from "ai"
import { Effect } from "effect"
import { sniffAttachmentMime } from "@/util/media"

type ToolContent = Extract<ToolResultPart["output"], { type: "content" }>["value"][number]
type ImageContent = ImagePart | FilePart | ToolContent
type ModelPart = Exclude<ModelMessage["content"], string>[number]
export type InlineImage = { mime: string; url: string }
export type Normalizer = (input: InlineImage) => Effect.Effect<InlineImage, unknown>

export const IMAGE_INPUT_OMITTED =
  "[Image input unavailable: the provider rejected images in this request. Continue using text, source files, DOM checks and other tools. Do not repeatedly read the same images or claim visual verification; report any remaining visual checks honestly. Original files are preserved.]"

function isImage(part: ImageContent) {
  return (
    part.type === "image" ||
    part.type === "image-data" ||
    part.type === "image-url" ||
    part.type === "image-file-id" ||
    ((part.type === "file" || part.type === "file-data" || part.type === "media") &&
      part.mediaType.startsWith("image/"))
  )
}

function dataURL(data: DataContent | URL, mime = "image/png"): string | undefined {
  if (data instanceof URL) return data.protocol === "data:" ? data.href : undefined
  if (typeof data === "string") {
    if (data.startsWith("data:")) return data
    // Remote URLs remain provider-owned; never fetch arbitrary URLs here.
    if (/^[a-z][a-z\d+.-]*:/i.test(data)) return undefined
    return `data:${mime};base64,${data}`
  }
  return `data:${mime};base64,${Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("base64")}`
}

const preparePart = Effect.fnUntraced(function* <T extends ImageContent>(
  part: T,
  normalize: Normalizer,
  omit: boolean,
) {
  if (!isImage(part)) return part
  if (omit) return { type: "text" as const, text: IMAGE_INPUT_OMITTED }
  const url =
    part.type === "image"
      ? dataURL(part.image, part.mediaType)
      : part.type === "image-url"
        ? dataURL(part.url)
        : "data" in part
          ? dataURL(part.data, "mediaType" in part ? part.mediaType : undefined)
          : undefined
  if (!url) return part
  const comma = url.indexOf(",")
  const bytes = Buffer.from(url.slice(comma + 1), "base64")
  const declared = url.slice(5, url.indexOf(";"))
  const mime = sniffAttachmentMime(bytes, declared)
  const canonicalURL = `data:${mime};base64,${bytes.toString("base64")}`
  const prepared = yield* normalize({ mime, url: canonicalURL }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!prepared)
    return {
      type: "text" as const,
      text: "[Image input unavailable: decoding or size validation failed. The original file is preserved. Continue with non-image tools and report that this image could not be viewed.]",
    }
  if (part.type === "image") return { ...part, image: prepared.url, mediaType: prepared.mime }
  if (part.type === "image-url") return { ...part, url: prepared.url }
  return {
    ...part,
    mediaType: prepared.mime,
    data: part.type === "file" ? prepared.url : prepared.url.slice(prepared.url.indexOf(",") + 1),
  }
})

/** Normalize inline media only; keep tool call/result pairing and all non-image data intact. */
export const prepareImages = Effect.fnUntraced(function* (
  messages: ModelMessage[],
  normalize: Normalizer,
  omit = false,
) {
  return yield* Effect.forEach(messages, (message): Effect.Effect<ModelMessage> => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return Effect.forEach(message.content, (part) => preparePart(part, normalize, omit)).pipe(
        Effect.map((content) => ({ ...message, content })),
      )
    }
    if ((message.role === "tool" || message.role === "assistant") && Array.isArray(message.content)) {
      return Effect.forEach(message.content, (part): Effect.Effect<ModelPart> => {
        if (part.type !== "tool-result" || part.output.type !== "content") return Effect.succeed(part)
        const output = part.output
        return Effect.forEach(output.value, (item) => preparePart(item, normalize, omit)).pipe(
          Effect.map((value) => ({ ...part, output: { ...output, value } })),
        )
      }).pipe(Effect.map((content) => ({ ...message, content }) as ModelMessage))
    }
    return Effect.succeed(message)
  })
})

export function imageCount(messages: ModelMessage[]) {
  return messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.reduce((total, part) => {
            if (message.role === "user") return total + Number(isImage(part as ImagePart | FilePart))
            return (
              total +
              (part.type === "tool-result" && part.output.type === "content"
                ? part.output.value.filter(isImage).length
                : 0)
            )
          }, 0)
        : 0),
    0,
  )
}

export function hasImages(messages: ModelMessage[]) {
  return imageCount(messages) > 0
}

/** Never treat balance, authentication, rate limit or arbitrary network failures as image rejection. */
export function isImageInputError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const item = error as {
    statusCode?: number
    message?: string
    responseBody?: string
    data?: { statusCode?: number; message?: string; responseBody?: string }
  }
  const status = item.statusCode ?? item.data?.statusCode
  if (status !== undefined && ![400, 413, 415, 422].includes(status)) return false
  const text = [item.message, item.responseBody, item.data?.message, item.data?.responseBody].filter(Boolean).join(" ")
  return /(?:unsupported|invalid|corrupt(?:ed)?|could not (?:decode|process)|unable to (?:decode|process))\s+(?:base64\s+)?image|image[^\n]{0,100}(?:unsupported|invalid|too large|too many|exceed|maximum|dimensions|decode|valid.{0,25}format)|too many images|invalid.{0,20}image_url/i.test(
    text,
  )
}

export * as LLMImageInput from "./image-input"
