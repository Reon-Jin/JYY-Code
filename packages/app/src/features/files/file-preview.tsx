import DOMPurify from "dompurify"
import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import {
  ArrowLeft,
  Circle,
  Columns2,
  Eraser,
  Eye,
  File as FileIcon,
  Hand,
  Minus,
  MousePointer2,
  PenLine,
  Pencil,
  Redo2,
  RefreshCw,
  Save,
  Square,
  Type,
  Undo2,
} from "lucide-solid"
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  Show,
  Suspense,
  useContext,
  type JSX,
} from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { createFileApi, fileContentQueryOptions } from "./file-query"
import { isDeletedChange, isEditableText, previewKind, type PreviewKind } from "./file-types"
import { oldContentFromUnifiedDiff } from "../changes/unified-diff"
import { renderMarkdown } from "../conversation/markdown"
import { completeUIPerformanceStage } from "../../performance/ui-performance"
import {
  base64FromBytes,
  flattenPdfAnnotations,
  pdfPageRows,
  translatePdfText,
  type PdfAnnotation,
  type PdfAnnotationTool,
  type PdfLayout,
} from "./pdf-preview"
import "./file-preview.css"

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
export const MAX_DOCUMENT_PREVIEW_BYTES = 256 * 1024 * 1024
export const PREVIEW_ZOOM_MIN = 0.5
export const PREVIEW_ZOOM_MAX = 4
const PDF_BASE_SCALE = 1.35

const LazyFileEditor = lazy(async () => ({ default: (await import("./file-editor")).FileEditor }))
const LazySpreadsheetEditor = lazy(async () => ({ default: (await import("./spreadsheet-editor")).SpreadsheetEditor }))

type FileSaveInput = {
  content: string
  encoding?: "base64"
  revision: string
}

export type FilePreviewProps = {
  directory: string
  workspaceID?: string
  sessionID?: string
  path: string
  change?: VcsFileDiff
  onClose?: () => void
  onDirtyChange?: (dirty: boolean) => void
}

function errorText(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : tr("files.unable-to-load")
}

function isConflict(cause: unknown) {
  const value = cause instanceof Error ? cause.message : JSON.stringify(cause)
  return /409|conflict|revision|changed since/i.test(value)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeBase64Content(value: string | undefined) {
  if (!value) return undefined
  try {
    return decodeBase64(value)
  } catch {
    return undefined
  }
}

export function contentBytes(content: FileContent | undefined) {
  if (!content?.content || content.encoding !== "base64") return undefined
  return decodeBase64Content(content.content)
}

export function contentDataUrl(content: FileContent | undefined) {
  if (!content?.content || content.encoding !== "base64" || !content.mimeType) return undefined
  return `data:${content.mimeType};base64,${content.content}`
}

export function contentText(content: FileContent | undefined) {
  if (!content?.content) return undefined
  if (content.encoding !== "base64") return content.content
  const bytes = contentBytes(content)
  return bytes ? new TextDecoder().decode(bytes) : undefined
}

export function pdfCanvasMetrics(viewport: { width: number; height: number }, outputScale: number) {
  const scale = Number.isFinite(outputScale) && outputScale > 0 ? outputScale : 1
  return {
    width: Math.ceil(viewport.width * scale),
    height: Math.ceil(viewport.height * scale),
    cssWidth: Math.ceil(viewport.width),
    cssHeight: Math.ceil(viewport.height),
    outputScale: scale,
  }
}

export function nextPreviewZoom(current: number, deltaY: number) {
  const value = Number.isFinite(current) ? current : 1
  const factor = deltaY < 0 ? 1.1 : 1 / 1.1
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, value * factor))
}

function pdfAssetUrl(directory: "cmaps" | "standard_fonts") {
  if (typeof document === "undefined") return `pdfjs/${directory}/`
  return new URL(`${import.meta.env.BASE_URL}pdfjs/${directory}/`, document.baseURI).toString()
}

const ZoomContext = createContext<(deltaY: number) => void>()

function ZoomSurface(props: { class?: string; dataKind?: string; children: JSX.Element }) {
  const [zoom, setZoom] = createSignal(1)
  const adjustZoom = (deltaY: number) => setZoom((current) => nextPreviewZoom(current, deltaY))

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    adjustZoom(event.deltaY)
  }

  return (
    <ZoomContext.Provider value={adjustZoom}>
      <div
        class={`file-preview__zoom-viewport${props.class ? ` ${props.class}` : ""}`}
        data-kind={props.dataKind}
        onWheel={onWheel}
      >
        <div class="file-preview__zoom-surface" style={{ transform: `scale(${zoom()})` }}>
          {props.children}
        </div>
      </div>
    </ZoomContext.Provider>
  )
}

function PreviewHeader(props: { path: string; onClose?: () => void; toolbar?: JSX.Element; readOnly?: boolean }) {
  return (
    <header class="file-preview__header">
      <Show when={props.onClose}>
        <Button class="file-preview__back" size="small" variant="ghost" onClick={props.onClose}>
          <ArrowLeft aria-hidden="true" />
          {tr("files.back-to-session")}
        </Button>
      </Show>
      <FileIcon aria-hidden="true" />
      <code class="file-preview__path">{props.path}</code>
      <Show when={props.readOnly}>
        <span class="file-preview__readonly">{tr("files.read-only")}</span>
      </Show>
      {props.toolbar}
    </header>
  )
}

type PdfTool = "select" | "hand" | "eraser" | PdfAnnotationTool

type PdfPreviewProps = {
  content: FileContent
  revision: string
  saving?: boolean
  error?: string
  onSave?: (input: FileSaveInput) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

type PdfPointerGesture =
  | { kind: "pan"; x: number; y: number; scrollLeft: number; scrollTop: number }
  | { kind: "annotation"; annotation: PdfAnnotation }
  | { kind: "move-text"; annotation: PdfAnnotation; x: number; y: number }

function normalizedPdfPoint(event: PointerEvent, surface: HTMLDivElement) {
  const bounds = surface.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  }
}

function annotationBounds(annotation: PdfAnnotation) {
  if (annotation.tool === "pen" && annotation.points?.length) {
    const xs = annotation.points.map((point) => point.x)
    const ys = annotation.points.map((point) => point.y)
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
  }
  const x = annotation.x ?? 0
  const y = annotation.y ?? 0
  const width = annotation.width ?? 0
  const height = annotation.height ?? 0
  return { left: Math.min(x, x + width), right: Math.max(x, x + width), top: Math.min(y, y + height), bottom: Math.max(y, y + height) }
}

function annotationAtPoint(annotation: PdfAnnotation, point: { x: number; y: number }) {
  const bounds = annotationBounds(annotation)
  const tolerance = annotation.tool === "pen" ? 0.02 : 0.01
  return (
    point.x >= bounds.left - tolerance &&
    point.x <= bounds.right + tolerance &&
    point.y >= bounds.top - tolerance &&
    point.y <= bounds.bottom + tolerance
  )
}

function drawPdfAnnotation(svg: SVGSVGElement, annotation: PdfAnnotation, selected = false) {
  const create = (name: string) => document.createElementNS("http://www.w3.org/2000/svg", name)
  const element =
    annotation.tool === "pen"
      ? create("path")
      : annotation.tool === "line"
        ? create("line")
      : annotation.tool === "rectangle"
        ? create("rect")
        : annotation.tool === "ellipse"
          ? create("ellipse")
          : create("text")

  element.setAttribute("data-annotation-id", annotation.id)
  element.setAttribute("data-annotation-tool", annotation.tool)
  if (selected) element.setAttribute("data-annotation-selected", "true")
  element.setAttribute("stroke", annotation.color)
  element.setAttribute("fill", annotation.tool === "text" ? annotation.color : "none")
  if (annotation.tool === "pen") {
    const points = annotation.points ?? []
    element.setAttribute("d", points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "))
    element.setAttribute("stroke-width", String(annotation.strokeWidth ?? 0.004))
    element.setAttribute("stroke-linecap", "round")
    element.setAttribute("stroke-linejoin", "round")
  } else if (annotation.tool === "line") {
    element.setAttribute("x1", String(annotation.x ?? 0))
    element.setAttribute("y1", String(annotation.y ?? 0))
    element.setAttribute("x2", String((annotation.x ?? 0) + (annotation.width ?? 0)))
    element.setAttribute("y2", String((annotation.y ?? 0) + (annotation.height ?? 0)))
    element.setAttribute("stroke-width", String(annotation.strokeWidth ?? 0.003))
    element.setAttribute("stroke-linecap", "round")
  } else if (annotation.tool === "rectangle") {
    const bounds = annotationBounds(annotation)
    element.setAttribute("x", String(bounds.left))
    element.setAttribute("y", String(bounds.top))
    element.setAttribute("width", String(bounds.right - bounds.left))
    element.setAttribute("height", String(bounds.bottom - bounds.top))
    element.setAttribute("stroke-width", String(annotation.strokeWidth ?? 0.003))
  } else if (annotation.tool === "ellipse") {
    const bounds = annotationBounds(annotation)
    element.setAttribute("cx", String((bounds.left + bounds.right) / 2))
    element.setAttribute("cy", String((bounds.top + bounds.bottom) / 2))
    element.setAttribute("rx", String((bounds.right - bounds.left) / 2))
    element.setAttribute("ry", String((bounds.bottom - bounds.top) / 2))
    element.setAttribute("stroke-width", String(annotation.strokeWidth ?? 0.003))
  } else {
    const fontSize = annotation.fontSize ?? 0.03
    element.setAttribute("x", String(annotation.x ?? 0))
    element.setAttribute("y", String((annotation.y ?? 0) + fontSize))
    element.setAttribute("font-size", String(fontSize))
    element.setAttribute("font-family", "sans-serif")
    element.setAttribute("stroke", "none")
    element.textContent = annotation.text ?? ""
  }

  svg.append(element)
}

function PdfWorkspacePreview(props: PdfPreviewProps) {
  let host: HTMLDivElement | undefined
  let viewportHost: HTMLDivElement | undefined
  let translationAbort: AbortController | undefined
  let gesture: PdfPointerGesture | undefined
  const overlayHosts = new Map<number, SVGSVGElement>()
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [zoom, setZoom] = createSignal(1)
  const [layout, setLayout] = createSignal<PdfLayout>("single")
  const [tool, setTool] = createSignal<PdfTool>("select")
  const [color, setColor] = createSignal("#e5484d")
  const [strokeWidth, setStrokeWidth] = createSignal(3)
  const [fontSize, setFontSize] = createSignal(24)
  const [history, setHistory] = createSignal<PdfAnnotation[][]>([[]])
  const [historyIndex, setHistoryIndex] = createSignal(0)
  const [savedAnnotations, setSavedAnnotations] = createSignal<PdfAnnotation[]>([])
  const [draftAnnotation, setDraftAnnotation] = createSignal<PdfAnnotation>()
  const [selectedAnnotationID, setSelectedAnnotationID] = createSignal<string>()
  const [selectedText, setSelectedText] = createSignal("")
  const [translation, setTranslation] = createSignal("")
  const [translationError, setTranslationError] = createSignal<string>()
  const [translating, setTranslating] = createSignal(false)
  const [documentVersion, setDocumentVersion] = createSignal(0)
  let documentProxy: PDFDocumentProxy | undefined
  let loadingTask: PDFDocumentLoadingTask | undefined
  let loadGeneration = 0
  let hasRenderedPdf = false
  let restoreScrollPosition: { left: number; top: number } | undefined
  let basePdfSource: Uint8Array | undefined
  let savedPdfContent: string | undefined
  const pageRenderTasks = new Map<number, { cancel: () => void }>()
  const incomingEncodedContent = createMemo(() => (props.content.encoding === "base64" ? props.content.content : undefined))
  const [displayedEncodedContent, setDisplayedEncodedContent] = createSignal<string>()
  createEffect(() => {
    const incoming = incomingEncodedContent()
    if (incoming && incoming === savedPdfContent) return
    setDisplayedEncodedContent(incoming)
  })
  const encodedContent = createMemo(() => displayedEncodedContent())
  const annotations = createMemo(() => history()[historyIndex()] ?? [])
  const dirty = createMemo(() => JSON.stringify(annotations()) !== JSON.stringify(savedAnnotations()))

  const updateAnnotations = (next: PdfAnnotation[]) => {
    const currentIndex = historyIndex()
    const nextHistory = [...history().slice(0, currentIndex + 1), next]
    setHistory(nextHistory)
    setHistoryIndex(nextHistory.length - 1)
  }

  const undo = () => {
    if (historyIndex() === 0) return
    setHistoryIndex((index) => index - 1)
  }

  const redo = () => {
    if (historyIndex() >= history().length - 1) return
    setHistoryIndex((index) => index + 1)
  }

  const renderOverlay = (page: number) => {
    const svg = overlayHosts.get(page)
    if (!svg) return
    svg.replaceChildren()
    const draft = draftAnnotation()
    const selected = selectedAnnotationID()
    for (const annotation of annotations()) {
      if (annotation.page !== page || annotation.id === draft?.id) continue
      drawPdfAnnotation(svg, annotation, annotation.id === selected)
    }
    if (draft?.page === page) drawPdfAnnotation(svg, draft, draft.id === selected)
  }

  createEffect(() => {
    annotations()
    draftAnnotation()
    selectedAnnotationID()
    for (const page of overlayHosts.keys()) renderOverlay(page)
    props.onDirtyChange?.(dirty())
  })

  const save = async () => {
    const data = basePdfSource ?? decodeBase64Content(encodedContent())
    if (!data?.byteLength || !dirty() || props.saving || !props.onSave) return
    const flattened = await flattenPdfAnnotations(data, annotations())
    const content = base64FromBytes(flattened)
    savedPdfContent = content
    try {
      await props.onSave({ content, encoding: "base64", revision: props.revision })
    } catch (cause) {
      savedPdfContent = undefined
      throw cause
    }
    setSavedAnnotations([...annotations()])
    setDraftAnnotation(undefined)
  }

  const clearTranslation = () => {
    translationAbort?.abort()
    translationAbort = undefined
    setSelectedText("")
    setTranslation("")
    setTranslationError(undefined)
    setTranslating(false)
  }

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setZoom((current) => nextPreviewZoom(current, event.deltaY))
  }

  const startPan = (event: PointerEvent, surface: HTMLDivElement) => {
    if (!viewportHost) return
    gesture = {
      kind: "pan",
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewportHost.scrollLeft,
      scrollTop: viewportHost.scrollTop,
    }
    surface.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const startTextEditor = (page: number, surface: HTMLDivElement, point: { x: number; y: number }, existing?: PdfAnnotation) => {
    const editor = window.document.createElement("div")
    editor.className = "file-preview__pdf-text-input"
    const handle = window.document.createElement("button")
    handle.type = "button"
    handle.className = "file-preview__pdf-text-input-handle"
    handle.setAttribute("aria-label", tr("files.pdf-move-text"))
    handle.textContent = "⠿"
    const input = window.document.createElement("input")
    const surfaceWidth = surface.getBoundingClientRect().width
    const textColor = existing?.color ?? color()
    let textSize = existing?.fontSize ? Math.round(existing.fontSize * surfaceWidth) : fontSize()
    input.type = "text"
    input.value = existing?.text ?? ""
    input.placeholder = tr("files.pdf-text-placeholder")
    input.style.color = textColor
    input.style.fontSize = `${textSize}px`
    const controls = window.document.createElement("label")
    controls.className = "file-preview__pdf-text-input-controls"
    const controlLabel = window.document.createElement("span")
    controlLabel.textContent = tr("files.pdf-font-size")
    const sizeRange = window.document.createElement("input")
    sizeRange.type = "range"
    sizeRange.min = "12"
    sizeRange.max = "48"
    sizeRange.value = String(textSize)
    sizeRange.setAttribute("aria-label", tr("files.pdf-font-size"))
    const sizeValue = window.document.createElement("output")
    sizeValue.value = String(textSize)
    sizeValue.textContent = String(textSize)
    controls.append(controlLabel, sizeRange, sizeValue)
    editor.append(controls, handle, input)
    surface.append(editor)

    let x = existing?.x ?? point.x
    let y = existing?.y ?? point.y
    let closed = false
    let drag: { offsetX: number; offsetY: number } | undefined
    const position = () => {
      editor.style.left = `${x * 100}%`
      editor.style.top = `${y * 100}%`
    }
    const finish = (save: boolean) => {
      if (closed) return
      closed = true
      if (save && input.value.trim()) {
        const surfaceBounds = surface.getBoundingClientRect()
        const inputBounds = input.getBoundingClientRect()
        const next: PdfAnnotation = {
            id: existing?.id ?? crypto.randomUUID(),
            page,
            tool: "text",
            color: textColor,
            text: input.value.trim(),
            x,
            y,
            width: Math.min(0.5, Math.max(0.12, inputBounds.width / surfaceBounds.width)),
            height: Math.max(0.045, inputBounds.height / surfaceBounds.height),
            fontSize: Math.max(0.012, textSize / surfaceBounds.width),
          }
        updateAnnotations(existing ? annotations().map((annotation) => (annotation.id === existing.id ? next : annotation)) : [...annotations(), next])
        setSelectedAnnotationID(next.id)
      }
      editor.remove()
    }
    const onMove = (event: PointerEvent) => {
      if (!drag) return
      const bounds = surface.getBoundingClientRect()
      x = Math.min(0.88, Math.max(0, (event.clientX - bounds.left - drag.offsetX) / bounds.width))
      y = Math.min(0.96, Math.max(0, (event.clientY - bounds.top - drag.offsetY) / bounds.height))
      position()
    }
    const onUp = (event: PointerEvent) => {
      drag = undefined
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    }

    position()
    input.addEventListener("pointerdown", (event) => event.stopPropagation())
    controls.addEventListener("pointerdown", (event) => event.stopPropagation())
    sizeRange.addEventListener("input", () => {
      textSize = Number(sizeRange.value)
      input.style.fontSize = `${textSize}px`
      sizeValue.value = String(textSize)
      sizeValue.textContent = String(textSize)
      setFontSize(textSize)
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        finish(true)
      } else if (event.key === "Escape") {
        event.preventDefault()
        finish(false)
      }
    })
    editor.addEventListener("focusout", () => window.setTimeout(() => {
      if (!editor.contains(window.document.activeElement)) finish(true)
    }))
    handle.addEventListener("pointerdown", (event) => {
      const bounds = surface.getBoundingClientRect()
      drag = { offsetX: event.clientX - bounds.left - x * bounds.width, offsetY: event.clientY - bounds.top - y * bounds.height }
      handle.setPointerCapture(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
    })
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
    input.focus()
  }

  const onPointerDown = (event: PointerEvent, page: number, surface: HTMLDivElement) => {
    if (event.button !== 0) return
    const activeTool = tool()
    const target = event.target instanceof Element ? event.target : undefined
    const annotationID = target?.closest("[data-annotation-id]")?.getAttribute("data-annotation-id")
    const selectedAnnotation = annotationID ? annotations().find((annotation) => annotation.id === annotationID) : undefined
    if (activeTool === "select" && selectedAnnotation?.tool === "text") {
      setSelectedAnnotationID(selectedAnnotation.id)
      if (event.detail > 1) {
        startTextEditor(page, surface, { x: selectedAnnotation.x ?? 0, y: selectedAnnotation.y ?? 0 }, selectedAnnotation)
      } else {
        gesture = { kind: "move-text", annotation: selectedAnnotation, ...normalizedPdfPoint(event, surface) }
        surface.setPointerCapture(event.pointerId)
      }
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Let the browser handle native selection only when the pointer starts on
    // actual text. The text-layer container covers the whole page, including
    // blank/image areas, which should still be draggable.
    if (activeTool === "select" && target?.closest(".file-preview__pdf-text-layer span")) return
    if (activeTool === "select") {
      window.getSelection()?.removeAllRanges()
      clearTranslation()
      setSelectedAnnotationID(undefined)
    }
    if (activeTool === "select" || activeTool === "hand") {
      startPan(event, surface)
      return
    }

    const point = normalizedPdfPoint(event, surface)
    if (activeTool === "eraser") {
      const next = [...annotations()]
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index]?.page !== page || !annotationAtPoint(next[index]!, point)) continue
        next.splice(index, 1)
        updateAnnotations(next)
        break
      }
      event.preventDefault()
      return
    }

    if (activeTool === "text") {
      startTextEditor(page, surface, point)
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const annotation: PdfAnnotation =
      activeTool === "pen"
        ? { id: crypto.randomUUID(), page, tool: "pen", color: color(), strokeWidth: strokeWidth() / 1000, points: [point] }
        : {
            id: crypto.randomUUID(),
            page,
            tool: activeTool,
            color: color(),
            strokeWidth: strokeWidth() / 1000,
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
          }
    gesture = { kind: "annotation", annotation }
    setDraftAnnotation(annotation)
    surface.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent, surface: HTMLDivElement) => {
    if (!gesture) return
    if (gesture.kind === "pan" && viewportHost) {
      viewportHost.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.x)
      viewportHost.scrollTop = gesture.scrollTop - (event.clientY - gesture.y)
      return
    }
    if (gesture.kind === "move-text") {
      const point = normalizedPdfPoint(event, surface)
      const annotation = {
        ...gesture.annotation,
        x: Math.min(0.88, Math.max(0, (gesture.annotation.x ?? 0) + point.x - gesture.x)),
        y: Math.min(0.96, Math.max(0, (gesture.annotation.y ?? 0) + point.y - gesture.y)),
      }
      setDraftAnnotation(annotation)
      return
    }
    if (gesture.kind !== "annotation") return
    const point = normalizedPdfPoint(event, surface)
    const annotation =
      gesture.annotation.tool === "pen"
        ? { ...gesture.annotation, points: [...(gesture.annotation.points ?? []), point] }
        : {
            ...gesture.annotation,
            width: point.x - (gesture.annotation.x ?? point.x),
            height: point.y - (gesture.annotation.y ?? point.y),
          }
    gesture = { kind: "annotation", annotation }
    setDraftAnnotation(annotation)
  }

  const onPointerUp = (event: PointerEvent, surface: HTMLDivElement) => {
    if (gesture?.kind === "annotation") updateAnnotations([...annotations(), gesture.annotation])
    if (gesture?.kind === "move-text") {
      const moved = draftAnnotation()
      if (moved?.id === gesture.annotation.id) {
        updateAnnotations(annotations().map((annotation) => (annotation.id === moved.id ? moved : annotation)))
      }
    }
    gesture = undefined
    setDraftAnnotation(undefined)
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
  }

  createEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ""
      const anchor = selection?.anchorNode
      const element =
        anchor?.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor?.parentElement
      if (!text || !element || !viewportHost?.contains(element) || !element.closest(".file-preview__pdf-text-layer")) {
        clearTranslation()
        return
      }

      translationAbort?.abort()
      const controller = new AbortController()
      translationAbort = controller
      setSelectedText(text)
      setTranslation("")
      setTranslationError(undefined)
      setTranslating(true)
      void translatePdfText(text, controller.signal)
        .then((value) => {
          if (translationAbort !== controller) return
          setTranslation(value)
        })
        .catch((cause) => {
          if (controller.signal.aborted || translationAbort !== controller) return
          setTranslationError(errorText(cause))
        })
        .finally(() => {
          if (translationAbort === controller) setTranslating(false)
        })
    }
    document.addEventListener("selectionchange", onSelectionChange)
    onCleanup(() => {
      document.removeEventListener("selectionchange", onSelectionChange)
      translationAbort?.abort()
    })
  })

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      const key = event.key.toLowerCase()
      if (key === "s") {
        event.preventDefault()
        void save()
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault()
        redo()
      } else if (key === "z") {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  createEffect(() => {
    const data = decodeBase64Content(encodedContent())
    if (!host) return
    if (data?.byteLength && !basePdfSource) basePdfSource = data.slice()
    let cancelled = false
    let currentLoadingTask: PDFDocumentLoadingTask | undefined
    let currentDocument: PDFDocumentProxy | undefined
    const generation = ++loadGeneration
    documentProxy = undefined
    overlayHosts.clear()
    for (const task of pageRenderTasks.values()) task.cancel()
    pageRenderTasks.clear()
    if (!hasRenderedPdf) setState("loading")
    setMessage(undefined)

    const load = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error(tr("files.binary-too-large"))
      const pdfjs = await import("pdfjs-dist")
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc
      currentLoadingTask = pdfjs.getDocument({
        data,
        cMapUrl: pdfAssetUrl("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: pdfAssetUrl("standard_fonts"),
      })
      loadingTask = currentLoadingTask
      currentDocument = await currentLoadingTask.promise
      documentProxy = currentDocument
      if (!cancelled) setDocumentVersion((version) => version + 1)
    }

    void load().catch((cause) => {
      if (cancelled) return
      setMessage(errorText(cause))
      setState("error")
    })
    onCleanup(() => {
      cancelled = true
      loadGeneration += 1
      overlayHosts.clear()
      for (const task of pageRenderTasks.values()) task.cancel()
      pageRenderTasks.clear()
      void currentLoadingTask?.destroy()
      void currentDocument?.destroy()
      if (loadingTask === currentLoadingTask) loadingTask = undefined
      if (documentProxy === currentDocument) documentProxy = undefined
    })
  })

  createEffect(() => {
    const targetZoom = zoom()
    const targetLayout = layout()
    documentVersion()
    const currentDocument = documentProxy
    const currentHost = host
    const currentViewport = viewportHost
    const generation = loadGeneration
    if (!currentDocument || !currentHost || !currentViewport) return

    for (const task of pageRenderTasks.values()) task.cancel()
    pageRenderTasks.clear()
    overlayHosts.clear()
    currentHost.replaceChildren()
    currentHost.dataset.layout = targetLayout
    if (!hasRenderedPdf) setState("loading")
    setMessage(undefined)

    const slots: HTMLDivElement[] = []
    const renderedPages = new Set<number>()
    const isCurrent = () => generation === loadGeneration && documentProxy === currentDocument

    const renderPage = async (pageNumber: number, slot: HTMLDivElement) => {
      if (!isCurrent() || renderedPages.has(pageNumber)) return
      renderedPages.add(pageNumber)
      try {
        const [page, pdfjs] = await Promise.all([currentDocument.getPage(pageNumber), import("pdfjs-dist")])
        if (!isCurrent()) return
        const pageViewport = page.getViewport({ scale: PDF_BASE_SCALE * targetZoom })
        const outputScale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
        const metrics = pdfCanvasMetrics(pageViewport, outputScale)
        slot.style.minHeight = `${metrics.cssHeight + 24}px`
        slot.style.minWidth = `${metrics.cssWidth}px`

        const surface = window.document.createElement("div")
        surface.className = "file-preview__pdf-page-surface"
        surface.dataset.tool = tool()
        surface.style.width = `${metrics.cssWidth}px`
        surface.style.height = `${metrics.cssHeight}px`
        slot.replaceChildren(surface)

        const canvas = window.document.createElement("canvas")
        canvas.width = metrics.width
        canvas.height = metrics.height
        canvas.style.width = `${metrics.cssWidth}px`
        canvas.style.height = `${metrics.cssHeight}px`
        canvas.className = "file-preview__pdf-page"
        const context = canvas.getContext("2d")
        if (!context) throw new Error(tr("files.render-failed"))
        surface.append(canvas)

      const textLayer = window.document.createElement("div")
      textLayer.className = "file-preview__pdf-text-layer"
      // PDF.js positions glyphs with --scale-factor. Without it, the
      // selectable layer is mis-sized and its text can visibly overlap the
      // rendered canvas while selecting.
      textLayer.style.setProperty("--scale-factor", String(pageViewport.scale))
      surface.append(textLayer)

        const annotationLayer = window.document.createElementNS("http://www.w3.org/2000/svg", "svg")
        annotationLayer.setAttribute("class", "file-preview__pdf-annotation-layer")
        annotationLayer.setAttribute("width", "100%")
        annotationLayer.setAttribute("height", "100%")
        annotationLayer.setAttribute("viewBox", "0 0 1 1")
        annotationLayer.setAttribute("preserveAspectRatio", "none")
        surface.append(annotationLayer)
        overlayHosts.set(pageNumber, annotationLayer)
        renderOverlay(pageNumber)

        surface.addEventListener("pointerdown", (event) => onPointerDown(event, pageNumber, surface))
        surface.addEventListener("pointermove", (event) => onPointerMove(event, surface))
        surface.addEventListener("pointerup", (event) => onPointerUp(event, surface))
        surface.addEventListener("pointercancel", (event) => onPointerUp(event, surface))

        const renderTask = page.render({
          canvasContext: context,
          viewport: pageViewport,
          transform: metrics.outputScale === 1 ? undefined : [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0],
        })
        pageRenderTasks.set(pageNumber, renderTask)
        await Promise.all([
          renderTask.promise,
          new pdfjs.TextLayer({
            textContentSource: await page.getTextContent(),
            container: textLayer,
            viewport: pageViewport,
          }).render(),
        ])
        if (isCurrent()) {
          hasRenderedPdf = true
          setState("ready")
        }
      } catch (cause) {
        if (!isCurrent()) return
        setMessage(errorText(cause))
        setState("error")
      } finally {
        pageRenderTasks.delete(pageNumber)
      }
    }

    const renderVisiblePages = () => {
      const top = Math.max(0, currentViewport.scrollTop - currentViewport.clientHeight * 2)
      const bottom = currentViewport.scrollTop + currentViewport.clientHeight * 3
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index]!
        if (slot.offsetTop + slot.offsetHeight < top || slot.offsetTop > bottom) continue
        void renderPage(index + 1, slot)
      }
    }

    for (const row of pdfPageRows(currentDocument.numPages, targetLayout)) {
      const rowElement = window.document.createElement("div")
      rowElement.className = "file-preview__pdf-page-row"
      currentHost.append(rowElement)
      for (const pageNumber of row) {
        const slot = window.document.createElement("div")
        slot.className = "file-preview__pdf-page-slot"
        slot.style.minHeight = "1100px"
        slot.dataset.page = String(pageNumber)
        rowElement.append(slot)
        slots.push(slot)
      }
    }

    const Observer = typeof window.IntersectionObserver === "function" ? window.IntersectionObserver : undefined
    const observer = Observer
      ? new Observer(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              const slot = entry.target as HTMLDivElement
              const pageNumber = Number(slot.dataset.page)
              if (pageNumber > 0) void renderPage(pageNumber, slot)
            }
          },
          { root: currentViewport, rootMargin: "1200px 0px" },
        )
      : undefined

    slots.forEach((slot) => observer?.observe(slot))
    currentViewport.addEventListener("scroll", renderVisiblePages, { passive: true })
    if (restoreScrollPosition) {
      currentViewport.scrollLeft = restoreScrollPosition.left
      currentViewport.scrollTop = restoreScrollPosition.top
      restoreScrollPosition = undefined
    }
    renderVisiblePages()

    onCleanup(() => {
      currentViewport.removeEventListener("scroll", renderVisiblePages)
      observer?.disconnect()
      overlayHosts.clear()
      for (const task of pageRenderTasks.values()) task.cancel()
      pageRenderTasks.clear()
    })
  })

  createEffect(() => {
    tool()
    for (const svg of overlayHosts.values()) svg.parentElement?.setAttribute("data-tool", tool())
  })

  return (
    <div class="file-preview__document file-preview__document--pdf" data-kind="pdf">
      <div class="file-preview__pdf-toolbar" role="toolbar" aria-label={tr("files.pdf-toolbar")}>
        <Button size="icon" variant={tool() === "select" ? "secondary" : "ghost"} aria-label={tr("files.pdf-select")} onClick={() => setTool("select")}>
          <MousePointer2 aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "hand" ? "secondary" : "ghost"} aria-label={tr("files.pdf-hand")} onClick={() => setTool("hand")}>
          <Hand aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "pen" ? "secondary" : "ghost"} aria-label={tr("files.pdf-pen")} onClick={() => setTool("pen")}>
          <PenLine aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "text" ? "secondary" : "ghost"} aria-label={tr("files.pdf-text")} onClick={() => setTool("text")}>
          <Type aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "line" ? "secondary" : "ghost"} aria-label={tr("files.pdf-line")} onClick={() => setTool("line")}>
          <Minus aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "rectangle" ? "secondary" : "ghost"} aria-label={tr("files.pdf-rectangle")} onClick={() => setTool("rectangle")}>
          <Square aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "ellipse" ? "secondary" : "ghost"} aria-label={tr("files.pdf-ellipse")} onClick={() => setTool("ellipse")}>
          <Circle aria-hidden="true" />
        </Button>
        <Button size="icon" variant={tool() === "eraser" ? "secondary" : "ghost"} aria-label={tr("files.pdf-eraser")} onClick={() => setTool("eraser")}>
          <Eraser aria-hidden="true" />
        </Button>
        <label class="file-preview__pdf-color" aria-label={tr("files.pdf-color")}>
          <input type="color" value={color()} onInput={(event) => setColor(event.currentTarget.value)} />
        </label>
        <Show when={tool() === "pen" || tool() === "line" || tool() === "rectangle" || tool() === "ellipse"}>
          <label class="file-preview__pdf-stroke-width">
            <span>{tr("files.pdf-stroke-width")}</span>
            <input
              aria-label={tr("files.pdf-stroke-width")}
              type="range"
              min="1"
              max="12"
              value={strokeWidth()}
              onInput={(event) => setStrokeWidth(Number(event.currentTarget.value))}
            />
            <span class="file-preview__pdf-stroke-preview" style={{ height: `${strokeWidth()}px` }} aria-hidden="true" />
            <output>{strokeWidth()}</output>
          </label>
        </Show>
        <span class="file-preview__pdf-toolbar-spacer" />
        <Button size="icon" variant="ghost" aria-label={tr("files.pdf-undo")} disabled={historyIndex() === 0} onClick={undo}>
          <Undo2 aria-hidden="true" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={tr("files.pdf-redo")} disabled={historyIndex() >= history().length - 1} onClick={redo}>
          <Redo2 aria-hidden="true" />
        </Button>
        <Button
          size="icon"
          variant={layout() === "spread" ? "secondary" : "ghost"}
          aria-label={tr("files.pdf-two-page")}
          onClick={() => setLayout((value) => (value === "single" ? "spread" : "single"))}
        >
          <Columns2 aria-hidden="true" />
        </Button>
        <Button size="small" variant="secondary" disabled={!dirty() || props.saving} onClick={() => void save()}>
          <Save aria-hidden="true" />
          {props.saving ? tr("files.saving") : tr("files.save")}
        </Button>
      </div>
      <Show when={state() === "loading"}>
        <p class="file-preview__state" role="status">
          <Spinner /> {tr("files.loading-preview")}
        </p>
      </Show>
      <Show when={state() === "error"}>
        <div class="file-preview__state">
          <InlineError message={message() ?? tr("files.render-failed")} />
        </div>
      </Show>
      <Show when={props.error}>
        <div class="file-preview__pdf-error"><InlineError message={props.error!} /></div>
      </Show>
      <div class="file-preview__pdf-workspace">
        <div ref={viewportHost} class="file-preview__document-viewport" onWheel={onWheel}>
          <div ref={host} class="file-preview__document-host" />
        </div>
        <aside class="file-preview__pdf-translation" aria-live="polite">
          <h2>{tr("files.pdf-translation")}</h2>
          <Show
            when={selectedText()}
            fallback={<p>{tr("files.pdf-translation-empty")}</p>}
          >
            <p class="file-preview__pdf-selection">{selectedText()}</p>
            <Show when={translating()}>
              <p><Spinner /> {tr("files.pdf-translating")}</p>
            </Show>
            <Show when={translation()}><p>{translation()}</p></Show>
            <Show when={translationError()}><InlineError message={translationError()!} /></Show>
          </Show>
        </aside>
      </div>
    </div>
  )
}


function DocxPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [html, setHtml] = createSignal<string>()
  const encodedContent = createMemo(() => (props.content.encoding === "base64" ? props.content.content : undefined))

  createEffect(() => {
    const data = decodeBase64Content(encodedContent())
    if (!host) return
    let cancelled = false
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)
    setHtml(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES)
        throw new Error(tr("files.binary-too-large"))
      const mammoth = await import("mammoth")
      const converter = mammoth.default ?? mammoth
      const result = await converter.convertToHtml({
        arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      })
      if (cancelled) return
      setHtml(
        DOMPurify.sanitize(result.value, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
          FORBID_ATTR: ["srcset"],
        }),
      )
      setState("ready")
    }

    void render().catch((cause) => {
      if (cancelled) return
      setMessage(errorText(cause))
      setState("error")
    })
    onCleanup(() => {
      cancelled = true
      host?.replaceChildren()
    })
  })

  return (
    <ZoomSurface class="file-preview__document" dataKind="docx">
      <Show when={state() === "loading"}>
        <p class="file-preview__state" role="status">
          <Spinner /> {tr("files.loading-preview")}
        </p>
      </Show>
      <Show when={state() === "error"}>
        <div class="file-preview__state">
          <InlineError message={message() ?? tr("files.render-failed")} />
        </div>
      </Show>
      <Show when={html()}>
        <article class="file-preview__docx" innerHTML={html()!} />
      </Show>
      <div ref={host} class="file-preview__document-host" />
    </ZoomSurface>
  )
}

function BinaryDocumentPreview(
  props: PdfPreviewProps & {
    kind: PreviewKind
  },
) {
  return props.kind === "pdf" ? <PdfWorkspacePreview {...props} /> : <DocxPreview content={props.content} />
}

function htmlWithPreviewBase(source: string, baseUrl: string) {
  const zoomScript = `<script>(() => { window.addEventListener("wheel", (event) => { if (!event.ctrlKey) return; event.preventDefault(); parent.postMessage({ type: "jyycode-html-preview-zoom", deltaY: event.deltaY }, "*"); }, { passive: false }); })();</script>`
  const runtime = `${/<base\b/i.test(source) ? "" : `<base href="${baseUrl.replaceAll('"', "&quot;")}">`}${zoomScript}`
  const head = /<head\b[^>]*>/i.exec(source)
  if (!head || head.index === undefined) return `${runtime}${source}`
  const insertAt = head.index + head[0].length
  return `${source.slice(0, insertAt)}${runtime}${source.slice(insertAt)}`
}

function HtmlPreview(props: { source: string; path: string; previewUrl: string }) {
  const adjustZoom = useContext(ZoomContext)
  let frame: HTMLIFrameElement | undefined
  const baseUrl = () => new URL(".", props.previewUrl).toString()
  const html = () => htmlWithPreviewBase(props.source, baseUrl())

  createEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame?.contentWindow || event.data?.type !== "jyycode-html-preview-zoom") return
      adjustZoom?.(Number(event.data.deltaY))
    }
    window.addEventListener("message", onMessage)
    onCleanup(() => window.removeEventListener("message", onMessage))
  })

  return (
    <iframe
      ref={frame}
      class="file-preview__html"
      title={props.path}
      sandbox="allow-scripts allow-forms allow-modals"
      referrerPolicy="no-referrer"
      srcdoc={html()}
    />
  )
}

function PptxPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const encodedContent = createMemo(() => (props.content.encoding === "base64" ? props.content.content : undefined))

  createEffect(() => {
    const data = decodeBase64Content(encodedContent())
    if (!host) return
    let cancelled = false
    let viewer: { destroy: () => void } | undefined
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) {
        throw new Error(tr("files.binary-too-large"))
      }
      const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer")
      viewer = await PptxViewer.open(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        host,
        {
          fitMode: "contain",
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
          pdfjs: false,
          renderMode: "list",
          zipLimits: RECOMMENDED_ZIP_LIMITS,
        },
      )
      if (cancelled) {
        viewer.destroy()
        return
      }
      setState("ready")
    }

    void render().catch((cause) => {
      if (cancelled) return
      setMessage(errorText(cause))
      setState("error")
    })
    onCleanup(() => {
      cancelled = true
      viewer?.destroy()
      host?.replaceChildren()
    })
  })

  return (
    <ZoomSurface class="file-preview__pptx" dataKind="pptx">
      <Show when={state() === "loading"}>
        <p class="file-preview__state" role="status">
          <Spinner /> {tr("files.loading-preview")}
        </p>
      </Show>
      <Show when={state() === "error"}>
        <div class="file-preview__state">
          <InlineError message={message() ?? tr("files.render-failed")} />
        </div>
      </Show>
      <div ref={host} class="file-preview__pptx-host" />
    </ZoomSurface>
  )
}

function MediaPreview(props: { content: FileContent; kind: PreviewKind; streamUrl?: string }) {
  const [source, setSource] = createSignal<string>()
  const tooLarge = () => props.kind !== "video" && (contentBytes(props.content)?.byteLength ?? 0) > MAX_PREVIEW_BYTES

  createEffect(() => {
    if (props.kind === "video" && props.streamUrl) {
      setSource(props.streamUrl)
      return
    }
    const bytes = contentBytes(props.content)
    if (!bytes || tooLarge()) {
      setSource(undefined)
      return
    }

    if (typeof URL.createObjectURL !== "function") {
      setSource(contentDataUrl(props.content))
      return
    }

    const mimeType = props.content.mimeType ?? "application/octet-stream"
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    setSource(url)
    onCleanup(() => URL.revokeObjectURL(url))
  })

  return (
    <div class="file-preview__media" data-kind={props.kind}>
      <Show when={!tooLarge() && source()} fallback={<InlineError message={tr("files.binary-too-large")} />}>
        {(url) => (
          <Show
            when={props.kind === "image"}
            fallback={
              <Show when={props.kind === "video"} fallback={<audio controls src={url()} />}>
                <video controls preload="metadata" src={props.streamUrl ?? url()} />
              </Show>
            }
          >
            <ZoomSurface class="file-preview__image-viewport">
              <img src={url()} alt={props.content.mimeType ?? ""} />
            </ZoomSurface>
          </Show>
        )}
      </Show>
    </div>
  )
}

export function FilePreview(props: FilePreviewProps) {
  const data = useData()
  const kind = createMemo(() => previewKind(props.path))
  const [dirty, setDirty] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [draftEncoding, setDraftEncoding] = createSignal<"base64" | undefined>()
  const [draftRevision, setDraftRevision] = createSignal("")
  const [observedPath, setObservedPath] = createSignal("")
  const [observedRevision, setObservedRevision] = createSignal("")
  const [resetToken, setResetToken] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string>()
  const [conflict, setConflict] = createSignal(false)
  const [textPreview, setTextPreview] = createSignal(false)
  const deleted = createMemo(() => isDeletedChange(props.change))

  const query = createQuery(
    () => ({
      ...fileContentQueryOptions({
        client: data.client(),
        directory: props.directory,
        workspaceID: props.workspaceID,
        sessionID: props.sessionID,
        relativePath: props.path,
        live: true,
      }),
      enabled: Boolean(props.path),
    }),
    data.queryClient,
  )
  const api = createMemo(() =>
    createFileApi({
      client: data.client(),
      directory: props.directory,
      workspaceID: props.workspaceID,
      sessionID: props.sessionID,
      queryClient: data.queryClient(),
    }),
  )

  const historicalContent = createMemo<FileContent | undefined>(() => {
    if (!deleted()) return undefined
    const value = oldContentFromUnifiedDiff(props.change?.patch)
    if (value === undefined) return undefined
    return { type: "text", content: value, revision: `deleted:${props.path}` }
  })
  const displayedContent = createMemo(() => historicalContent() ?? query.data)
  let previewMarkedReady = false
  createEffect(() => {
    if (!previewMarkedReady && displayedContent()) {
      previewMarkedReady = true
      completeUIPerformanceStage("first-file-preview-ready")
    }
  })

  const updateDirty = (value: boolean) => {
    setDirty(value)
    props.onDirtyChange?.(value)
  }

  createEffect(() => {
    const content = displayedContent()
    const spreadsheet = kind() === "spreadsheet"
    if (!content || content.type !== "text" || (!spreadsheet && content.encoding === "base64")) return
    if (observedPath() !== props.path) {
      setObservedPath(props.path)
      setObservedRevision(content.revision)
      setDraftRevision(content.revision)
      setDraft(content.content)
      setDraftEncoding(content.encoding)
      setConflict(false)
      return
    }
    if (observedRevision() === content.revision) return
    setObservedRevision(content.revision)
    if (dirty()) {
      setConflict(true)
      return
    }
    setDraftRevision(content.revision)
    setDraft(content.content)
    setDraftEncoding(content.encoding)
  })

  const save = async (input: FileSaveInput) => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await api().write({
        path: props.path,
        content: input.content,
        encoding: input.encoding,
        revision: input.revision,
      })
      setDraft(input.content)
      setDraftEncoding(input.encoding)
      setDraftRevision(result.revision)
      setObservedRevision(result.revision)
      setConflict(false)
    } catch (cause) {
      setSaveError(errorText(cause))
      if (isConflict(cause)) setConflict(true)
      throw cause
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    const result = await query.refetch()
    const content = result.data ?? query.data
    const spreadsheet = kind() === "spreadsheet"
    if (!content || content.type !== "text" || (!spreadsheet && content.encoding === "base64")) return
    setObservedRevision(content.revision)
    setDraftRevision(content.revision)
    setDraft(content.content)
    setDraftEncoding(content.encoding)
    setConflict(false)
    setSaveError(undefined)
    setResetToken((value) => value + 1)
    updateDirty(false)
  }

  const textPreviewToolbar = (
    <Button size="small" variant="ghost" onClick={() => setTextPreview((value) => !value)}>
      <Show when={textPreview()} fallback={<Eye aria-hidden="true" />}>
        <Pencil aria-hidden="true" />
      </Show>
      <Show
        when={kind() === "html"}
        fallback={textPreview() ? tr("files.markdown-edit") : tr("files.markdown-preview")}
      >
        {textPreview() ? tr("files.html-edit") : tr("files.html-preview")}
      </Show>
    </Button>
  )

  const editor = (content: FileContent) => (
    <Suspense fallback={<p class="file-preview__state" role="status">{tr("files.loading")}</p>}>
      <LazyFileEditor
        path={props.path}
        content={draft()}
        revision={draftRevision() || content.revision}
        saving={saving()}
        error={saveError()}
        readOnly={deleted()}
        onSave={deleted() ? undefined : save}
        onDirtyChange={updateDirty}
        onExternalChange={() => setConflict(true)}
        onContentChange={setDraft}
        resetToken={resetToken()}
        onClose={props.onClose}
        toolbar={kind() === "markdown" || kind() === "html" ? textPreviewToolbar : undefined}
        initialDirty={dirty()}
      />
    </Suspense>
  )

  const spreadsheetEditor = (content: FileContent) => (
    <Suspense fallback={<p class="file-preview__state" role="status">{tr("files.loading")}</p>}>
      <LazySpreadsheetEditor
        path={props.path}
        content={draft()}
        encoding={draftEncoding()}
        revision={draftRevision() || content.revision}
        saving={saving()}
        error={saveError()}
        readOnly={deleted()}
        onSave={deleted() ? undefined : save}
        onDirtyChange={updateDirty}
        onExternalChange={() => setConflict(true)}
        onContentChange={(value, encoding) => {
          setDraft(value)
          setDraftEncoding(encoding)
        }}
        resetToken={resetToken()}
        onClose={props.onClose}
      />
    </Suspense>
  )

  return (
    <section class="file-preview" aria-label={props.path}>
      <div class="file-preview__viewport">
        <Show
          when={!query.isPending}
          fallback={
            <>
              <PreviewHeader path={props.path} onClose={props.onClose} />
              <p class="file-preview__state" role="status">
                <Spinner /> {tr("files.loading")}
              </p>
            </>
          }
        >
          <Show
            when={(!query.error || historicalContent()) && displayedContent()}
            fallback={
              <>
                <PreviewHeader path={props.path} onClose={props.onClose} />
                <div class="file-preview__state">
                  <InlineError message={query.error ? errorText(query.error) : tr("files.unable-to-load")} />
                  <Show when={query.error}>
                    <Button size="small" variant="secondary" onClick={() => void query.refetch()}>
                      <RefreshCw aria-hidden="true" />
                      {tr("files.retry")}
                    </Button>
                  </Show>
                </div>
              </>
            }
          >
            {(content) => {
              const spreadsheet = () => kind() === "spreadsheet" && content().type === "text"
              const editable = () =>
                content().type === "text" && content().encoding !== "base64" && isEditableText(props.path)
              const isTextPreviewKind = () => kind() === "markdown" || kind() === "html"
              const showTextEditor = () => editable() && (!isTextPreviewKind() || !textPreview())
              const showMarkdownPreview = () => kind() === "markdown" && editable() && textPreview()
              const showHtmlPreview = () => kind() === "html" && (!editable() || textPreview())
              const htmlSource = () => (editable() ? draft() : (contentText(content()) ?? ""))
              return (
                <>
                  <Show when={spreadsheet()}>{spreadsheetEditor(content())}</Show>
                  <Show when={showTextEditor()}>{editor(content())}</Show>
                  <Show when={showMarkdownPreview()}>
                    <PreviewHeader path={props.path} onClose={props.onClose} toolbar={textPreviewToolbar} readOnly />
                    <div class="file-preview__markdown-viewport">
                      <article
                        class="file-preview__markdown conversation-markdown"
                        innerHTML={renderMarkdown(draft())}
                      />
                    </div>
                  </Show>
                  <Show when={showHtmlPreview()}>
                    <PreviewHeader
                      path={props.path}
                      onClose={props.onClose}
                      toolbar={editable() ? textPreviewToolbar : undefined}
                      readOnly
                    />
                    <ZoomSurface class="file-preview__html-viewport">
                      <HtmlPreview
                        source={htmlSource()}
                        path={props.path}
                        previewUrl={data.filePreviewUrl(props.path, props.workspaceID, props.directory)}
                      />
                    </ZoomSurface>
                  </Show>
                  <Show
                    when={
                      !editable() &&
                      kind() !== "image" &&
                      kind() !== "video" &&
                      kind() !== "audio" &&
                      kind() !== "pdf" &&
                      kind() !== "docx" &&
                      kind() !== "pptx" &&
                      kind() !== "spreadsheet" &&
                      kind() !== "html"
                    }
                  >
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <div class="file-preview__state">
                      <InlineError message={tr("files.unsupported")} />
                    </div>
                  </Show>
                  <Show when={kind() === "spreadsheet" && !spreadsheet()}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <div class="file-preview__state">
                      <InlineError message={tr("files.binary-too-large")} />
                    </div>
                  </Show>
                  <Show when={kind() === "image" || kind() === "video" || kind() === "audio"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <MediaPreview
                      content={content()}
                      kind={kind()}
                      streamUrl={
                        kind() === "video"
                          ? data.fileMediaUrl(props.path, props.workspaceID, props.directory)
                          : undefined
                      }
                    />
                  </Show>
                  <Show when={kind() === "pdf" || kind() === "docx"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <BinaryDocumentPreview
                      content={content()}
                      kind={kind()}
                      revision={content().revision}
                      saving={saving()}
                      error={saveError()}
                      onSave={deleted() ? undefined : save}
                      onDirtyChange={updateDirty}
                    />
                  </Show>
                  <Show when={kind() === "pptx"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <PptxPreview content={content()} />
                  </Show>
                </>
              )
            }}
          </Show>
        </Show>
      </div>
      <Show when={conflict()}>
        <div class="file-preview__conflict" role="alert">
          <InlineError message={tr("files.conflict")} />
          <div>
            <Button size="small" variant="secondary" onClick={() => void reload()}>
              <RefreshCw aria-hidden="true" />
              {tr("files.reload")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => setConflict(false)}>
              {tr("files.continue-editing")}
            </Button>
          </div>
        </div>
      </Show>
    </section>
  )
}

export function isFilePreviewEditable(path: string, content: FileContent | undefined) {
  return Boolean(
    content &&
      content.type === "text" &&
      (previewKind(path) === "spreadsheet" || (content.encoding !== "base64" && isEditableText(path))),
  )
}
