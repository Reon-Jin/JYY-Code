import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { markdown } from "@codemirror/lang-markdown"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { sql } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { lineNumbers, highlightActiveLine, keymap } from "@codemirror/view"
import { EditorView } from "@codemirror/view"
import { ChevronLeft, Save } from "lucide-solid"
import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { tr } from "../../i18n/i18n-context"
import { isEditableText } from "./file-types"
import "./file-editor.css"

export type FileEditorSaveInput = { content: string; revision: string }

export type FileEditorProps = {
  path: string
  content: string
  revision: string
  readOnly?: boolean
  saving?: boolean
  error?: string
  onSave?: (input: FileEditorSaveInput) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onExternalChange?: () => void
  onClose?: () => void
  onContentChange?: (content: string) => void
  resetToken?: number
  toolbar?: JSX.Element
  initialDirty?: boolean
}

function fileExtension(path: string) {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

export function languageExtension(path: string): Extension {
  switch (fileExtension(path)) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "json":
      return javascript({
        jsx: ["jsx", "tsx"].includes(fileExtension(path)),
        typescript: ["ts", "tsx", "mts", "cts"].includes(fileExtension(path)),
      })
    case "md":
    case "markdown":
    case "mdown":
    case "mkdn":
    case "mdx":
      return markdown()
    case "html":
    case "htm":
    case "xml":
    case "vue":
      return html()
    case "css":
    case "scss":
    case "less":
      return css()
    case "py":
      return python()
    case "rs":
      return rust()
    case "sql":
      return sql()
    case "yaml":
    case "yml":
      return yaml()
    default:
      return []
  }
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--color-text)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-code)",
    fontSize: "0.78rem",
    lineHeight: "1.6",
  },
  ".cm-content": { minHeight: "100%", padding: "var(--space-4) 0" },
  ".cm-gutters": {
    minWidth: "44px",
    border: "0",
    backgroundColor: "var(--color-panel)",
    color: "var(--color-text-muted)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-2)" },
  ".cm-activeLine": { backgroundColor: "var(--color-accent-muted)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-accent-muted)", color: "var(--color-text)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-selection) !important" },
})

export function FileEditor(props: FileEditorProps) {
  let host: HTMLDivElement | undefined
  let view: EditorView | undefined
  let committedPath = props.path
  let committedContent = props.content
  let committedResetToken = props.resetToken
  let pendingContent: string | undefined
  let lastDirty = Boolean(props.initialDirty)
  const [dirty, setDirty] = createSignal(Boolean(props.initialDirty))
  const [localError, setLocalError] = createSignal<string>()
  const [viewReady, setViewReady] = createSignal(false)
  const language = new Compartment()
  const readOnly = new Compartment()
  const editable = new Compartment()

  const reportDirty = (value: boolean) => {
    if (lastDirty === value) return
    lastDirty = value
    setDirty(value)
    props.onDirtyChange?.(value)
  }

  const save = async () => {
    if (!view || props.readOnly || !props.onSave || props.saving || !dirty()) return
    setLocalError(undefined)
    try {
      const content = view.state.doc.toString()
      await props.onSave({ content, revision: props.revision })
      committedContent = content
      reportDirty(false)
    } catch (cause) {
      setLocalError(cause instanceof Error && cause.message ? cause.message : tr("files.unable-to-save"))
    }
  }

  const saveCommand = () => {
    void save()
    return true
  }

  onMount(() => {
    if (!host) return
    view = new EditorView({
      state: EditorState.create({
        doc: props.content,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          language.of(languageExtension(props.path)),
          readOnly.of(EditorState.readOnly.of(Boolean(props.readOnly))),
          editable.of(EditorView.editable.of(!props.readOnly)),
          keymap.of([
            { key: "Mod-s", run: saveCommand },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const content = update.state.doc.toString()
            pendingContent = content
            props.onContentChange?.(content)
            reportDirty(content !== committedContent)
          }),
          editorTheme,
        ],
      }),
      parent: host,
    })
    setViewReady(true)
  })

  createEffect(() => {
    viewReady()
    const path = props.path
    const content = props.content
    const isReadOnly = Boolean(props.readOnly)
    const resetToken = props.resetToken
    if (!view) return

    if (path !== committedPath || resetToken !== committedResetToken) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: [language.reconfigure(languageExtension(path))],
      })
      committedPath = path
      committedContent = content
      committedResetToken = resetToken
      pendingContent = undefined
      setLocalError(undefined)
      reportDirty(false)
    } else if (content !== committedContent) {
      if (content === pendingContent) {
        pendingContent = undefined
      } else if (dirty()) {
        props.onExternalChange?.()
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
        committedContent = content
        reportDirty(false)
      }
    }

    view.dispatch({
      effects: [
        readOnly.reconfigure(EditorState.readOnly.of(isReadOnly)),
        editable.reconfigure(EditorView.editable.of(!isReadOnly)),
      ],
    })
  })

  onCleanup(() => view?.destroy())

  return (
    <section class="file-editor" aria-label={props.path}>
      <header class="file-editor__header">
        <Show when={props.onClose}>
          <Button class="file-editor__back" size="small" variant="ghost" onClick={props.onClose}>
            <ChevronLeft aria-hidden="true" />
            {tr("files.back-to-files")}
          </Button>
        </Show>
        <code class="file-editor__path">{props.path}</code>
        <Show when={dirty()}>
          <span class="file-editor__dirty" aria-label={tr("files.unsaved")}>
            ●
          </span>
        </Show>
        <Show when={props.toolbar}>{props.toolbar}</Show>
        <Show when={!props.readOnly && props.onSave}>
          <Button
            class="file-editor__save"
            size="small"
            variant="secondary"
            disabled={!dirty() || props.saving}
            onClick={() => void save()}
          >
            <Show when={props.saving} fallback={<Save aria-hidden="true" />}>
              <Spinner />
            </Show>
            {props.saving ? tr("files.saving") : tr("files.save")}
          </Button>
        </Show>
        <Show when={props.readOnly}>
          <span class="file-editor__readonly">{tr("files.read-only")}</span>
        </Show>
      </header>
      <Show when={props.error || localError()}>
        <InlineError message={props.error ?? localError()!} />
      </Show>
      <div ref={host} class="file-editor__surface" data-read-only={props.readOnly ? "true" : "false"} />
    </section>
  )
}

export function canEditFile(path: string) {
  return isEditableText(path)
}
