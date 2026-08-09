import DOMPurify from "dompurify"
import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, Eye, File as FileIcon, Pencil, RefreshCw } from "lucide-solid"
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

function PdfPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  let viewportHost: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [zoom, setZoom] = createSignal(1)
  const [documentVersion, setDocumentVersion] = createSignal(0)
  let documentProxy: PDFDocumentProxy | undefined
  let loadingTask: PDFDocumentLoadingTask | undefined
  let loadGeneration = 0
  const pageRenderTasks = new Map<number, { cancel: () => void }>()
  const encodedContent = createMemo(() => (props.content.encoding === "base64" ? props.content.content : undefined))

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setZoom((current) => nextPreviewZoom(current, event.deltaY))
  }

  createEffect(() => {
    const data = decodeBase64Content(encodedContent())
    if (!host) return
    let cancelled = false
    let currentLoadingTask: PDFDocumentLoadingTask | undefined
    let currentDocument: PDFDocumentProxy | undefined
    const generation = ++loadGeneration
    documentProxy = undefined
    for (const task of pageRenderTasks.values()) task.cancel()
    pageRenderTasks.clear()
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) {
        throw new Error(tr("files.binary-too-large"))
      }
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

    void render().catch((cause) => {
      if (cancelled) return
      setMessage(errorText(cause))
      setState("error")
    })
    onCleanup(() => {
      cancelled = true
      loadGeneration += 1
      for (const task of pageRenderTasks.values()) task.cancel()
      pageRenderTasks.clear()
      host?.replaceChildren()
      void currentLoadingTask?.destroy()
      void currentDocument?.destroy()
      if (loadingTask === currentLoadingTask) loadingTask = undefined
      if (documentProxy === currentDocument) documentProxy = undefined
    })
  })

  createEffect(() => {
    const targetZoom = zoom()
    documentVersion()
    const currentDocument = documentProxy
    const currentHost = host
    const currentViewport = viewportHost
    const generation = loadGeneration
    if (!currentDocument || !currentHost || !currentViewport) return

    for (const task of pageRenderTasks.values()) task.cancel()
    pageRenderTasks.clear()
    currentHost.replaceChildren()
    setState("loading")
    setMessage(undefined)

    const slots: HTMLDivElement[] = []
    const renderedPages = new Set<number>()
    const isCurrent = () => generation === loadGeneration && documentProxy === currentDocument

    const renderPage = async (pageNumber: number, slot: HTMLDivElement) => {
      if (!isCurrent() || renderedPages.has(pageNumber)) return
      renderedPages.add(pageNumber)
      try {
        const page = await currentDocument.getPage(pageNumber)
        if (!isCurrent()) return
        const pageViewport = page.getViewport({ scale: PDF_BASE_SCALE * targetZoom })
        const outputScale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
        const metrics = pdfCanvasMetrics(pageViewport, outputScale)
        slot.style.minHeight = `${metrics.cssHeight + 24}px`
        const canvas = window.document.createElement("canvas")
        canvas.width = metrics.width
        canvas.height = metrics.height
        canvas.style.width = `${metrics.cssWidth}px`
        canvas.style.height = `${metrics.cssHeight}px`
        canvas.className = "file-preview__pdf-page"
        const context = canvas.getContext("2d")
        if (!context) throw new Error(tr("files.render-failed"))
        slot.replaceChildren(canvas)
        const renderTask = page.render({
          canvasContext: context,
          viewport: pageViewport,
          transform: metrics.outputScale === 1 ? undefined : [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0],
        })
        pageRenderTasks.set(pageNumber, renderTask)
        await renderTask.promise
        if (isCurrent()) setState("ready")
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

    for (let pageNumber = 1; pageNumber <= currentDocument.numPages; pageNumber += 1) {
      const slot = window.document.createElement("div")
      slot.className = "file-preview__pdf-page-slot"
      slot.style.minHeight = "1100px"
      currentHost.append(slot)
      slots.push(slot)
    }

    const Observer = typeof window.IntersectionObserver === "function" ? window.IntersectionObserver : undefined
    const observer = Observer
      ? new Observer(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              const pageNumber = Number((entry.target as HTMLElement).dataset.page)
              const slot = entry.target as HTMLDivElement
              if (pageNumber > 0) void renderPage(pageNumber, slot)
            }
          },
          { root: currentViewport, rootMargin: "1200px 0px" },
        )
      : undefined

    slots.forEach((slot, index) => {
      slot.dataset.page = String(index + 1)
      observer?.observe(slot)
    })
    currentViewport.addEventListener("scroll", renderVisiblePages, { passive: true })
    renderVisiblePages()

    onCleanup(() => {
      currentViewport.removeEventListener("scroll", renderVisiblePages)
      observer?.disconnect()
      for (const task of pageRenderTasks.values()) task.cancel()
      pageRenderTasks.clear()
    })
  })

  return (
    <div class="file-preview__document file-preview__document--pdf" data-kind="pdf">
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
      <div ref={viewportHost} class="file-preview__document-viewport" onWheel={onWheel}>
        <div ref={host} class="file-preview__document-host" />
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

function BinaryDocumentPreview(props: { kind: PreviewKind; content: FileContent }) {
  return props.kind === "pdf" ? <PdfPreview content={props.content} /> : <DocxPreview content={props.content} />
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
                    <BinaryDocumentPreview content={content()} kind={kind()} />
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
