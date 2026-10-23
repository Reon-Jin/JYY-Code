import { createEffect, createMemo, createSignal, createUniqueId, Index, onCleanup, Show } from "solid-js"
import { Dialog } from "../../components/ui/dialog"
import { useOptionalData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { openExternalUrl } from "../../platform/external-url"
import { loadMarkdownHighlighting, renderMarkdownBlocks, type MarkdownRenderMode } from "./markdown"
import { patchMarkdown } from "./markdown-dom"

function MarkdownBlock(props: { html: string; imageUrl: (source: string) => string | undefined }) {
  let host!: HTMLDivElement
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    patchMarkdown(host, props.html)
    for (const image of host.querySelectorAll<HTMLImageElement>("img[data-md-source]")) {
      const source = props.imageUrl(image.dataset.mdSource ?? "")
      if (source && image.getAttribute("src") !== source) {
        image.src = source
        delete image.dataset.mdImageState
      }
      if (!source) image.dataset.mdImageState = "failed"
      image.setAttribute("aria-label", tr("conversation.view-image", { name: image.alt || "图片" }))
      image.onerror = () => {
        image.dataset.mdImageState = "failed"
        image.alt = tr("conversation.image-unavailable")
      }
    }
    for (const diagram of host.querySelectorAll<HTMLElement>("[data-diagram-source]")) {
      if (diagram.dataset.diagramState) continue
      diagram.dataset.diagramState = "loading"
      const sourceKey = diagram.dataset.diagramSource!
      const source = decodeURIComponent(sourceKey)
      void import("./markdown-diagram")
        .then((module) => module.renderDiagram(source))
        .then((svg) => {
          if (disposed || !host.contains(diagram) || diagram.dataset.diagramSource !== sourceKey) return
          diagram.innerHTML = svg
          diagram.dataset.diagramState = "ready"
        })
        .catch(() => {
          if (disposed || !host.contains(diagram)) return
          diagram.textContent = tr("conversation.md-diagram-failed")
          diagram.dataset.diagramState = "failed"
        })
    }
  })
  return <div class="conversation-markdown__block" ref={host} />
}

export function MarkdownView(props: {
  source: string
  mode?: MarkdownRenderMode
  basePath?: string
  directory?: string
  workspaceID?: string
}) {
  const data = useOptionalData()
  const scope = `md-${createUniqueId().replace(/[^a-z0-9-]/gi, "")}`
  const [highlightReady, setHighlightReady] = createSignal(false)
  const [preview, setPreview] = createSignal<{ src: string; name: string }>()
  const [status, setStatus] = createSignal("")
  let root!: HTMLDivElement
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    if (highlightReady() || (!props.source.includes("```") && !props.source.includes("~~~"))) return
    void loadMarkdownHighlighting()
      .then(() => {
        if (!disposed) setHighlightReady(true)
      })
      .catch(() => undefined)
  })
  const blocks = createMemo(() => {
    highlightReady()
    return renderMarkdownBlocks(props.source, props.mode ?? "complete").map((html) =>
      html
        .replaceAll('id="footnote-', `id="${scope}-footnote-`)
        .replaceAll('href="#footnote-', `href="#${scope}-footnote-`)
        .replaceAll('aria-describedby="footnote-', `aria-describedby="${scope}-footnote-`),
    )
  })
  const imageUrl = (source: string): string | undefined => {
    if (/^(?:https?:|data:image\/|blob:https?:)/i.test(source)) return source
    if (/^file:/i.test(source)) {
      try {
        const url = new URL(source)
        if (url.host) return undefined
        source = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1")
      } catch {
        return undefined
      }
    }
    if (!source || (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source) && !/^[a-z]:[\\/]/i.test(source))) return undefined
    const path = source.replaceAll("\\", "/")
    const base = props.basePath?.replaceAll("\\", "/").replace(/[^/]*$/, "") ?? ""
    return data?.fileMediaUrl(
      /^(?:[a-z]:\/|\/)/i.test(path) ? path : base + path,
      props.workspaceID ?? data.workspaceID(),
      props.directory,
    )
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      if (!disposed) setStatus(tr("conversation.md-copied"))
    } catch {
      if (!disposed) setStatus(tr("conversation.md-copy-failed"))
    }
  }
  function handleClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : undefined
    if (!target) return
    const button = target.closest<HTMLButtonElement>("button[data-md-action]")
    if (button) {
      const action = button.dataset.mdAction
      const code = button.closest<HTMLElement>(".markdown-code")
      if (action === "copy-code") void copy(code?.querySelector("code")?.textContent ?? "")
      if (action === "copy-math") void copy(button.closest<HTMLElement>("[data-tex]")?.dataset.tex ?? "")
      if (action === "fold-code" && code) {
        const collapsed = code.dataset.mdCollapsed !== "true"
        code.dataset.mdCollapsed = String(collapsed)
        button.setAttribute("aria-expanded", String(!collapsed))
        button.textContent = tr(collapsed ? "conversation.md-expand-code" : "conversation.md-fold-code")
      }
      return
    }
    const image = target.closest<HTMLImageElement>("img[data-md-source]")
    if (image?.src && image.dataset.mdImageState !== "failed") {
      event.preventDefault()
      setPreview({ src: image.src, name: image.alt || "图片" })
      return
    }
    const link = target.closest<HTMLAnchorElement>("a")
    if (!link) return
    if (link.dataset.externalHref) {
      event.preventDefault()
      void openExternalUrl(link.dataset.externalHref).catch(() => {
        if (!disposed) setStatus(tr("conversation.md-link-failed"))
      })
    } else if (link.hash) {
      event.preventDefault()
      const id = decodeURIComponent(link.hash.slice(1))
      const anchor = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((node) => node.id === id)
      anchor?.scrollIntoView?.({ block: "nearest" })
      anchor?.setAttribute("tabindex", "-1")
      anchor?.focus({ preventScroll: true })
    }
  }
  return (
    <>
      <div
        class="conversation-markdown"
        ref={root}
        onClick={handleClick}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLImageElement) {
            event.preventDefault()
            event.target.click()
          }
        }}
      >
        <Index each={blocks()}>{(html) => <MarkdownBlock html={html()} imageUrl={imageUrl} />}</Index>
      </div>
      <span class="markdown-status" role="status" aria-live="polite">
        {status()}
      </span>
      <Show when={preview()}>
        {(image) => (
          <Dialog
            open
            title={image().name}
            showClose
            class="conversation-image-dialog"
            onClose={() => setPreview(undefined)}
          >
            <img src={image().src} alt={image().name} decoding="async" />
          </Dialog>
        )}
      </Show>
    </>
  )
}
