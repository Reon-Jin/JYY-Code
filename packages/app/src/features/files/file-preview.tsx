import DOMPurify from "dompurify"
import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, Eye, File as FileIcon, Pencil, RefreshCw, X } from "lucide-solid"
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api"
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { createFileApi, fileContentQueryOptions } from "./file-query"
import { isDeletedChange, isEditableText, previewKind, type PreviewKind } from "./file-types"
import { FileEditor, type FileEditorSaveInput } from "./file-editor"
import { oldContentFromUnifiedDiff } from "../changes/unified-diff"
import { renderMarkdown } from "../conversation/markdown"
import "./file-preview.css"

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
export const MAX_DOCUMENT_PREVIEW_BYTES = 256 * 1024 * 1024
export const PREVIEW_ZOOM_MIN = 0.5
export const PREVIEW_ZOOM_MAX = 4

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

export function contentBytes(content: FileContent | undefined) {
  if (!content?.content || content.encoding !== "base64") return undefined
  try {
    return decodeBase64(content.content)
  } catch {
    return undefined
  }
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

function ZoomSurface(props: { class?: string; children: JSX.Element }) {
  const [zoom, setZoom] = createSignal(1)

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setZoom((current) => nextPreviewZoom(current, event.deltaY))
  }

  return (
    <div class={`file-preview__zoom-viewport${props.class ? ` ${props.class}` : ""}`} onWheel={onWheel}>
      <div class="file-preview__zoom-surface" style={{ transform: `scale(${zoom()})` }}>
        {props.children}
      </div>
    </div>
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
      <Show when={props.onClose}>
        <Button
          class="file-preview__close"
          size="icon"
          variant="ghost"
          aria-label={tr("files.close")}
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </Show>
    </header>
  )
}

function PdfPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()

  createEffect(() => {
    const data = contentBytes(props.content)
    if (!host) return
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | undefined
    let documentProxy: PDFDocumentProxy | undefined
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) {
        throw new Error(tr("files.binary-too-large"))
      }
      const pdfjs = await import("pdfjs-dist")
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc
      loadingTask = pdfjs.getDocument({
        data,
        cMapUrl: pdfAssetUrl("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: pdfAssetUrl("standard_fonts"),
      })
      documentProxy = await loadingTask.promise
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        if (cancelled) return
        const page = await documentProxy.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1.35 })
        const outputScale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
        const metrics = pdfCanvasMetrics(viewport, outputScale)
        const canvas = window.document.createElement("canvas")
        canvas.width = metrics.width
        canvas.height = metrics.height
        canvas.style.width = `${metrics.cssWidth}px`
        canvas.style.height = `${metrics.cssHeight}px`
        canvas.className = "file-preview__pdf-page"
        const context = canvas.getContext("2d")
        if (!context) throw new Error(tr("files.render-failed"))
        host.append(canvas)
        await page.render({
          canvasContext: context,
          viewport,
          transform:
            metrics.outputScale === 1
              ? undefined
              : [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0],
        }).promise
      }
      if (!cancelled) setState("ready")
    }

    void render().catch((cause) => {
      if (cancelled) return
      setMessage(errorText(cause))
      setState("error")
    })
    onCleanup(() => {
      cancelled = true
      host?.replaceChildren()
      void loadingTask?.destroy()
      void documentProxy?.destroy()
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
      <ZoomSurface class="file-preview__document-viewport">
        <div ref={host} class="file-preview__document-host" />
      </ZoomSurface>
    </div>
  )
}

function DocxPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [html, setHtml] = createSignal<string>()
  const bytes = () => contentBytes(props.content)

  createEffect(() => {
    const data = bytes()
    if (!host) return
    let cancelled = false
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)
    setHtml(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error(tr("files.binary-too-large"))
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
    <div class="file-preview__document" data-kind="docx">
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
    </div>
  )
}

function BinaryDocumentPreview(props: { kind: PreviewKind; content: FileContent }) {
  return props.kind === "pdf" ? <PdfPreview content={props.content} /> : <DocxPreview content={props.content} />
}

function HtmlPreview(props: { content: FileContent; path: string }) {
  const html = () =>
    DOMPurify.sanitize(contentText(props.content) ?? "", {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["base", "embed", "form", "iframe", "meta", "object", "script"],
      FORBID_ATTR: ["srcset"],
    })

  return <iframe class="file-preview__html" title={props.path} sandbox="" referrerPolicy="no-referrer" srcdoc={html()} />
}

function PptxPreview(props: { content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()

  createEffect(() => {
    const data = contentBytes(props.content)
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
    <div class="file-preview__pptx" data-kind="pptx">
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
    </div>
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
  const [draftRevision, setDraftRevision] = createSignal("")
  const [observedPath, setObservedPath] = createSignal("")
  const [observedRevision, setObservedRevision] = createSignal("")
  const [resetToken, setResetToken] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string>()
  const [conflict, setConflict] = createSignal(false)
  const [markdownPreview, setMarkdownPreview] = createSignal(false)
  const deleted = createMemo(() => isDeletedChange(props.change))

  const query = createQuery(
    () => ({
      ...fileContentQueryOptions({
        client: data.client(),
        directory: props.directory,
        workspaceID: props.workspaceID,
        sessionID: props.sessionID,
        relativePath: props.path,
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

  const updateDirty = (value: boolean) => {
    setDirty(value)
    props.onDirtyChange?.(value)
  }

  createEffect(() => {
    const content = displayedContent()
    if (!content || content.type !== "text" || content.encoding === "base64") return
    if (observedPath() !== props.path) {
      setObservedPath(props.path)
      setObservedRevision(content.revision)
      setDraftRevision(content.revision)
      setDraft(content.content)
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
  })

  const save = async (input: FileEditorSaveInput) => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const result = await api().write({ path: props.path, content: input.content, revision: input.revision })
      setDraft(input.content)
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
    if (!content || content.type !== "text" || content.encoding === "base64") return
    setObservedRevision(content.revision)
    setDraftRevision(content.revision)
    setDraft(content.content)
    setConflict(false)
    setSaveError(undefined)
    setResetToken((value) => value + 1)
    updateDirty(false)
  }

  const markdownToolbar = (
    <Button size="small" variant="ghost" onClick={() => setMarkdownPreview((value) => !value)}>
      <Show when={markdownPreview()} fallback={<Eye aria-hidden="true" />}>
        <Pencil aria-hidden="true" />
      </Show>
      {markdownPreview() ? tr("files.markdown-edit") : tr("files.markdown-preview")}
    </Button>
  )

  const editor = (content: FileContent) => (
    <FileEditor
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
      toolbar={kind() === "markdown" ? markdownToolbar : undefined}
      initialDirty={dirty()}
    />
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
              const editable = () =>
                content().type === "text" && content().encoding !== "base64" && isEditableText(props.path)
              const isMarkdown = () => kind() === "markdown" && editable()
              return (
                <>
                  <Show when={editable() && (!isMarkdown() || !markdownPreview())}>{editor(content())}</Show>
                  <Show when={isMarkdown() && markdownPreview()}>
                    <PreviewHeader path={props.path} onClose={props.onClose} toolbar={markdownToolbar} readOnly />
                    <div class="file-preview__markdown-viewport">
                      <article class="file-preview__markdown conversation-markdown" innerHTML={renderMarkdown(draft())} />
                    </div>
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
                      kind() !== "html"
                    }
                  >
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <div class="file-preview__state">
                      <InlineError message={tr("files.unsupported")} />
                    </div>
                  </Show>
                  <Show when={kind() === "image" || kind() === "video" || kind() === "audio"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <MediaPreview
                      content={content()}
                      kind={kind()}
                      streamUrl={kind() === "video" ? data.fileMediaUrl(props.path, props.workspaceID) : undefined}
                    />
                  </Show>
                  <Show when={kind() === "pdf" || kind() === "docx"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <BinaryDocumentPreview content={content()} kind={kind()} />
                  </Show>
                  <Show when={kind() === "html"}>
                    <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                    <div class="file-preview__html-viewport">
                      <HtmlPreview content={content()} path={props.path} />
                    </div>
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
  return Boolean(content && content.type === "text" && content.encoding !== "base64" && isEditableText(path))
}
