import type { JyycodeClient } from "@jyycode-ai/sdk/v2/client"

export type PdfLayout = "single" | "spread"

export type PdfAnnotationTool = "pen" | "text" | "line" | "rectangle" | "ellipse"

export type PdfAnnotation = {
  id: string
  page: number
  tool: PdfAnnotationTool
  color: string
  points?: Array<{ x: number; y: number }>
  x?: number
  y?: number
  width?: number
  height?: number
  text?: string
  strokeWidth?: number
  fontSize?: number
}

export const PDF_TRANSLATION_MAX_CHARS = 5000

export type PdfTranslationInput = {
  client: Pick<JyycodeClient, "session">
  directory: string
  workspaceID?: string
  sessionID?: string
  text: string
  signal?: AbortSignal
}

export function pdfTranslationTarget(text: string) {
  const containsHan = /\p{Script=Han}/u.test(text)
  const containsJapaneseOrKoreanScript = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
  return containsHan && !containsJapaneseOrKoreanScript ? "en" : "zh-CN"
}

export function pdfPageRows(pageCount: number, layout: PdfLayout): number[][] {
  const pages = Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1)
  if (layout === "single") return pages.map((page) => [page])
  return pages.reduce<number[][]>((rows, page, index) => {
    if (index % 2 === 0) rows.push([page])
    else rows.at(-1)?.push(page)
    return rows
  }, [])
}

function translationSystem(target: ReturnType<typeof pdfTranslationTarget>) {
  const language = target === "en" ? "English" : "Simplified Chinese"
  return [
    "You are a translation engine.",
    `Translate the user's source text into ${language}.`,
    "Preserve technical terminology, formulas, citations, paragraph breaks, and list structure.",
    "Return only the translated text. Do not explain, summarize, quote the source, or use Markdown fences.",
  ].join(" ")
}

export async function translatePdfText(input: PdfTranslationInput): Promise<string> {
  const source = input.text.trim().slice(0, PDF_TRANSLATION_MAX_CHARS)
  if (!source) return ""
  const target = pdfTranslationTarget(source)
  const query = {
    directory: input.directory,
    ...(input.workspaceID ? { workspace: input.workspaceID } : {}),
  }
  const requestOptions = input.signal
    ? { throwOnError: true as const, signal: input.signal }
    : { throwOnError: true as const }
  let transientSessionID: string | undefined

  try {
    const parent = input.sessionID
      ? await input.client.session.get(
          { ...query, sessionID: input.sessionID },
          requestOptions,
        )
      : undefined
    const created = await input.client.session.create(
      {
        ...query,
        ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
        ...(input.sessionID ? { parentID: input.sessionID } : {}),
        ...(parent?.data?.agent ? { agent: parent.data.agent } : {}),
        ...(parent?.data?.model ? { model: parent.data.model } : {}),
        title: "PDF translation",
        multiAgent: false,
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      },
      requestOptions,
    )
    transientSessionID = created.data?.id
    if (!transientSessionID) throw new Error("Translation session could not be created")

    const response = await input.client.session.prompt(
      {
        ...query,
        sessionID: transientSessionID,
        ...(parent?.data?.agent ? { agent: parent.data.agent } : {}),
        ...(parent?.data?.model
          ? { model: { providerID: parent.data.model.providerID, modelID: parent.data.model.id } }
          : {}),
        system: translationSystem(target),
        tools: {},
        parts: [{ type: "text", text: source }],
      },
      requestOptions,
    )
    const translation = response.data?.parts
      .flatMap((part) => (part.type === "text" && !part.ignored ? [part.text] : []))
      .join("")
      .trim()
    if (!translation) throw new Error("Translation response was empty")
    return translation
  } finally {
    if (transientSessionID) {
      const session = { ...query, sessionID: transientSessionID }
      if (input.signal?.aborted) {
        await input.client.session.abort(session, { throwOnError: true }).catch(() => undefined)
      }
      await input.client.session.delete(session, { throwOnError: true }).catch(() => undefined)
    }
  }
}

export function base64FromBytes(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function colorComponents(color: string) {
  const value = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  if (!value) return [0, 0, 0] as const
  return [Number.parseInt(value[1]!, 16) / 255, Number.parseInt(value[2]!, 16) / 255, Number.parseInt(value[3]!, 16) / 255] as const
}

async function textPng(text: string, color: string, width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Unable to render PDF text annotation")
  context.fillStyle = color
  context.font = `${Math.max(14, Math.round(canvas.height * 0.72))}px sans-serif`
  context.textBaseline = "top"
  context.fillText(text, 0, 0, canvas.width)
  return canvas.toDataURL("image/png")
}

export async function flattenPdfAnnotations(source: Uint8Array, annotations: PdfAnnotation[]) {
  const { PDFDocument, rgb } = await import("pdf-lib")
  const document = await PDFDocument.load(source)
  const pages = document.getPages()

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1]
    if (!page) continue
    const width = page.getWidth()
    const height = page.getHeight()
    const [red, green, blue] = colorComponents(annotation.color)
    const color = rgb(red, green, blue)
    const x = annotation.x ?? 0
    const y = annotation.y ?? 0
    const annotationWidth = annotation.width ?? 0
    const annotationHeight = annotation.height ?? 0
    const left = Math.min(x, x + annotationWidth) * width
    const bottom = (1 - Math.max(y, y + annotationHeight)) * height
    const drawingWidth = Math.abs(annotationWidth) * width
    const drawingHeight = Math.abs(annotationHeight) * height

    if (annotation.tool === "pen" && annotation.points && annotation.points.length > 1) {
      for (let index = 1; index < annotation.points.length; index += 1) {
        const previous = annotation.points[index - 1]!
        const point = annotation.points[index]!
        page.drawLine({
          start: { x: previous.x * width, y: (1 - previous.y) * height },
          end: { x: point.x * width, y: (1 - point.y) * height },
          color,
          thickness: Math.max(1, Math.min(width, height) * (annotation.strokeWidth ?? 0.003)),
        })
      }
      continue
    }

    if (annotation.tool === "line") {
      page.drawLine({
        start: { x: x * width, y: (1 - y) * height },
        end: { x: (x + annotationWidth) * width, y: (1 - (y + annotationHeight)) * height },
        color,
        thickness: Math.max(1, Math.min(width, height) * (annotation.strokeWidth ?? 0.003)),
      })
      continue
    }

    if (annotation.tool === "rectangle") {
      page.drawRectangle({
        x: left,
        y: bottom,
        width: drawingWidth,
        height: drawingHeight,
        borderColor: color,
        borderWidth: Math.max(1, Math.min(width, height) * (annotation.strokeWidth ?? 0.003)),
      })
      continue
    }

    if (annotation.tool === "ellipse") {
      page.drawEllipse({
        x: left + drawingWidth / 2,
        y: bottom + drawingHeight / 2,
        xScale: drawingWidth / 2,
        yScale: drawingHeight / 2,
        borderColor: color,
        borderWidth: Math.max(1, Math.min(width, height) * (annotation.strokeWidth ?? 0.003)),
      })
      continue
    }

    if (annotation.tool === "text" && annotation.text) {
      const image = await document.embedPng(await textPng(annotation.text, annotation.color, annotationWidth * 1200, annotationHeight * 1200))
      page.drawImage(image, { x: left, y: bottom, width: drawingWidth, height: drawingHeight })
    }
  }

  return document.save()
}
