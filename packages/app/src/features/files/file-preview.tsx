import DOMPurify from "dompurify"
import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, Eye, File as FileIcon, Pencil, RefreshCw, X } from "lucide-solid"
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

function BinaryDocumentPreview(props: { kind: PreviewKind; content: FileContent }) {
  let host: HTMLDivElement | undefined
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [html, setHtml] = createSignal<string>()
  const bytes = () => contentBytes(props.content)

  createEffect(() => {
    const kind = props.kind
    const data = bytes()
    if (!host || (kind !== "pdf" && kind !== "docx")) return
    let cancelled = false
    host.replaceChildren()
    setState("loading")
    setMessage(undefined)
    setHtml(undefined)

    const render = async () => {
      if (!data?.byteLength || data.byteLength > MAX_PREVIEW_BYTES) throw new Error(tr("files.binary-too-large"))
      if (kind === "docx") {
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
        return
      }

      const pdfjs = await import("pdfjs-dist")
      const documentTask = pdfjs.getDocument({ data })
      const document = await documentTask.promise
      const page = await document.getPage(1)
      const viewport = page.getViewport({ scale: 1.35 })
      const canvas = window.document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.className = "file-preview__pdf-page"
      const context = canvas.getContext("2d")
      if (!context) throw new Error(tr("files.render-failed"))
      if (cancelled) return
      host.append(canvas)
      await page.render({ canvasContext: context, viewport }).promise
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
    })
  })

  return (
    <div class="file-preview__document" data-kind={props.kind}>
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

function MediaPreview(props: { content: FileContent; kind: PreviewKind }) {
  const [source, setSource] = createSignal<string>()
  const tooLarge = () => (contentBytes(props.content)?.byteLength ?? 0) > MAX_PREVIEW_BYTES

  createEffect(() => {
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
                <video controls src={url()} />
              </Show>
            }
          >
            <img src={url()} alt={props.content.mimeType ?? ""} />
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
                  <article class="file-preview__markdown conversation-markdown" innerHTML={renderMarkdown(draft())} />
                </Show>
                <Show
                  when={
                    !editable() &&
                    kind() !== "image" &&
                    kind() !== "video" &&
                    kind() !== "audio" &&
                    kind() !== "pdf" &&
                    kind() !== "docx"
                  }
                >
                  <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                  <div class="file-preview__state">
                    <InlineError message={tr("files.unsupported")} />
                  </div>
                </Show>
                <Show when={kind() === "image" || kind() === "video" || kind() === "audio"}>
                  <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                  <MediaPreview content={content()} kind={kind()} />
                </Show>
                <Show when={kind() === "pdf" || kind() === "docx"}>
                  <PreviewHeader path={props.path} onClose={props.onClose} readOnly />
                  <BinaryDocumentPreview content={content()} kind={kind()} />
                </Show>
              </>
            )
          }}
        </Show>
      </Show>
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
