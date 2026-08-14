import type { CellObject, WorkBook, WorkSheet } from "xlsx"
import { ChevronLeft, File as FileIcon, Save } from "lucide-solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { tr } from "../../i18n/i18n-context"
import "./spreadsheet-editor.css"

const MAX_ROWS = 500
const MAX_COLUMNS = 100

type Encoding = "base64" | undefined
type SpreadsheetLibrary = typeof import("xlsx")
type CellPosition = { row: number; column: number }

export type SpreadsheetEditorSaveInput = {
  content: string
  encoding?: "base64"
  revision: string
}

export type SpreadsheetEditorProps = {
  path: string
  content: string
  encoding?: "base64"
  revision: string
  readOnly?: boolean
  saving?: boolean
  error?: string
  onSave?: (input: SpreadsheetEditorSaveInput) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onExternalChange?: () => void
  onClose?: () => void
  onContentChange?: (content: string, encoding?: "base64") => void
  resetToken?: number
}

type SpreadsheetPayload = { content: string; encoding: Encoding }

function fileExtension(path: string) {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function columnLabel(column: number) {
  let value = column + 1
  let result = ""
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

function sheetRange(library: SpreadsheetLibrary, sheet: WorkSheet) {
  if (sheet["!ref"]) return library.utils.decode_range(sheet["!ref"])
  return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
}

function displayCell(cell: CellObject | undefined) {
  if (!cell || cell.v === undefined || cell.v === null) return cell?.f ? `=${cell.f}` : ""
  if (cell.f) return `=${cell.f}`
  if (cell.w !== undefined) return cell.w
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10)
  return String(cell.v)
}

function sheetRows(library: SpreadsheetLibrary, sheet: WorkSheet) {
  const range = sheetRange(library, sheet)
  const rowCount = Math.min(MAX_ROWS, Math.max(1, range.e.r + 1))
  const columnCount = Math.min(MAX_COLUMNS, Math.max(1, range.e.c + 1))
  return Array.from({ length: rowCount }, (_, row) =>
    Array.from({ length: columnCount }, (_, column) =>
      displayCell(sheet[library.utils.encode_cell({ r: row, c: column })]),
    ),
  )
}

function cellFromText(existing: CellObject | undefined, value: string): CellObject {
  const cell = { ...(existing ?? { t: "s" as const }) }
  delete cell.f
  delete cell.F
  delete cell.w

  if (value === "") {
    cell.t = "z"
    delete cell.v
    return cell
  }
  if (value.startsWith("=") && value.length > 1) {
    cell.t = "n"
    cell.f = value.slice(1)
    delete cell.v
    return cell
  }
  if (value === "TRUE" || value === "FALSE") {
    cell.t = "b"
    cell.v = value === "TRUE"
    return cell
  }
  const number = Number(value)
  if (value.trim() !== "" && Number.isFinite(number)) {
    cell.t = "n"
    cell.v = number
    return cell
  }
  cell.t = "s"
  cell.v = value
  return cell
}

function workbookType(path: string): import("xlsx").BookType {
  switch (fileExtension(path)) {
    case "xls":
    case "xlt":
      return "xls"
    case "xlsm":
    case "xltm":
      return "xlsm"
    case "xlsb":
      return "xlsb"
    case "ods":
      return "ods"
    case "fods":
      return "fods"
    default:
      return "xlsx"
  }
}

function isDelimited(path: string) {
  return fileExtension(path) === "csv" || fileExtension(path) === "tsv"
}

function serializeWorkbook(library: SpreadsheetLibrary, workbook: WorkBook, path: string): SpreadsheetPayload {
  const sheetName = workbook.SheetNames[0]
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined
  if (!sheet) throw new Error(tr("files.spreadsheet-empty"))
  if (isDelimited(path)) {
    const content = library.utils.sheet_to_csv(sheet, {
      FS: fileExtension(path) === "tsv" ? "\t" : ",",
      blankrows: true,
    })
    return { content, encoding: undefined }
  }
  const content = library.write(workbook, {
    type: "base64",
    bookType: workbookType(path),
    bookVBA: ["xlsm", "xltm"].includes(fileExtension(path)),
    compression: true,
  }) as string
  return { content, encoding: "base64" }
}

function loadWorkbook(library: SpreadsheetLibrary, content: string, encoding: Encoding) {
  return library.read(encoding === "base64" ? decodeBase64(content) : content, {
    type: encoding === "base64" ? "array" : "string",
    cellDates: true,
    cellStyles: true,
    bookVBA: encoding === "base64",
  })
}

function sourceKey(path: string, content: string, encoding: Encoding, resetToken: number | undefined) {
  return `${path}\u0000${encoding ?? "text"}\u0000${resetToken ?? 0}\u0000${content}`
}

export function SpreadsheetEditor(props: SpreadsheetEditorProps) {
  let library: SpreadsheetLibrary | undefined
  let workbook: WorkBook | undefined
  let committedKey = ""
  let pendingKey: string | undefined
  let loadSequence = 0
  let lastDirty = false
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = createSignal<string>()
  const [sheetNames, setSheetNames] = createSignal<string[]>([])
  const [activeSheet, setActiveSheet] = createSignal("")
  const [rows, setRows] = createSignal<string[][]>([])
  const [selected, setSelected] = createSignal<CellPosition>({ row: 0, column: 0 })
  const [dirty, setDirty] = createSignal(false)
  const [localError, setLocalError] = createSignal<string>()

  const reportDirty = (value: boolean) => {
    if (lastDirty === value) return
    lastDirty = value
    setDirty(value)
    props.onDirtyChange?.(value)
  }

  const activeWorksheet = () => (workbook && activeSheet() ? workbook.Sheets[activeSheet()] : undefined)

  const load = async () => {
    const sequence = ++loadSequence
    const key = sourceKey(props.path, props.content, props.encoding, props.resetToken)
    setState("loading")
    setMessage(undefined)
    setLocalError(undefined)
    try {
      library = (await import("xlsx")) as SpreadsheetLibrary
      workbook = loadWorkbook(library, props.content, props.encoding)
      if (!workbook.SheetNames.length) throw new Error(tr("files.spreadsheet-empty"))
      if (sequence !== loadSequence) return
      setSheetNames(workbook.SheetNames)
      setActiveSheet(workbook.SheetNames[0]!)
      setRows(sheetRows(library, workbook.Sheets[workbook.SheetNames[0]!]!))
      setSelected({ row: 0, column: 0 })
      committedKey = key
      pendingKey = undefined
      reportDirty(false)
      setState("ready")
    } catch (cause) {
      if (sequence !== loadSequence) return
      workbook = undefined
      setSheetNames([])
      setRows([])
      setMessage(cause instanceof Error && cause.message ? cause.message : tr("files.spreadsheet-load-failed"))
      setState("error")
    }
  }

  createEffect(() => {
    const key = sourceKey(props.path, props.content, props.encoding, props.resetToken)
    if (key === pendingKey) {
      pendingKey = undefined
      return
    }
    if (key === committedKey) return
    if (dirty()) {
      props.onExternalChange?.()
      return
    }
    void load()
  })

  const selectSheet = (name: string) => {
    if (!workbook || !library || !workbook.Sheets[name]) return
    setActiveSheet(name)
    setRows(sheetRows(library, workbook.Sheets[name]!))
    setSelected({ row: 0, column: 0 })
  }

  const emitDraft = async () => {
    if (!workbook || !library) return
    try {
      const payload = serializeWorkbook(library, workbook, props.path)
      pendingKey = sourceKey(props.path, payload.content, payload.encoding, props.resetToken)
      props.onContentChange?.(payload.content, payload.encoding)
      reportDirty(true)
      setLocalError(undefined)
    } catch (cause) {
      setLocalError(cause instanceof Error && cause.message ? cause.message : tr("files.spreadsheet-save-failed"))
    }
  }

  const updateCell = (row: number, column: number, value: string) => {
    const sheet = activeWorksheet()
    if (!workbook || !library || !sheet || props.readOnly) return
    const address = library.utils.encode_cell({ r: row, c: column })
    sheet[address] = cellFromText(sheet[address], value)
    setRows((current) =>
      current.map((currentRow, rowIndex) =>
        rowIndex === row ? currentRow.map((cell, columnIndex) => (columnIndex === column ? value : cell)) : currentRow,
      ),
    )
    setSelected({ row, column })
    void emitDraft()
  }

  const save = async () => {
    if (!workbook || !library || props.readOnly || !props.onSave || props.saving || !dirty()) return
    setLocalError(undefined)
    try {
      const payload = serializeWorkbook(library, workbook, props.path)
      await props.onSave({ ...payload, revision: props.revision })
      committedKey = sourceKey(props.path, payload.content, payload.encoding, props.resetToken)
      pendingKey = undefined
      reportDirty(false)
    } catch (cause) {
      setLocalError(cause instanceof Error && cause.message ? cause.message : tr("files.spreadsheet-save-failed"))
    }
  }

  const selectedValue = () => rows()[selected().row]?.[selected().column] ?? ""

  onCleanup(() => {
    loadSequence += 1
  })

  return (
    <section class="spreadsheet-editor" aria-label={props.path}>
      <header class="spreadsheet-editor__header">
        <Show when={props.onClose}>
          <Button class="spreadsheet-editor__back" size="small" variant="ghost" onClick={props.onClose}>
            <ChevronLeft aria-hidden="true" />
            {tr("files.back-to-files")}
          </Button>
        </Show>
        <FileIcon aria-hidden="true" />
        <code class="spreadsheet-editor__path">{props.path}</code>
        <Show when={dirty()}>
          <span class="spreadsheet-editor__dirty" aria-label={tr("files.unsaved")}>
            *
          </span>
        </Show>
        <Show when={!props.readOnly && props.onSave}>
          <Button
            class="spreadsheet-editor__save"
            size="small"
            variant="secondary"
            disabled={!dirty() || props.saving || state() !== "ready"}
            onClick={() => void save()}
          >
            <Show when={props.saving} fallback={<Save aria-hidden="true" />}>
              <Spinner />
            </Show>
            {props.saving ? tr("files.saving") : tr("files.save")}
          </Button>
        </Show>
        <Show when={props.readOnly}>
          <span class="spreadsheet-editor__readonly">{tr("files.read-only")}</span>
        </Show>
      </header>
      <Show when={props.error || localError()}>
        <InlineError message={props.error ?? localError()!} />
      </Show>
      <Show
        when={state() === "ready"}
        fallback={
          <Show
            when={state() === "loading"}
            fallback={
              <div class="spreadsheet-editor__state">
                <InlineError message={message() ?? tr("files.spreadsheet-load-failed")} />
              </div>
            }
          >
            <p class="spreadsheet-editor__state" role="status">
              <Spinner /> {tr("files.spreadsheet-loading")}
            </p>
          </Show>
        }
      >
        <div class="spreadsheet-editor__formula-bar">
          <span class="spreadsheet-editor__cell-name">{`${columnLabel(selected().column)}${selected().row + 1}`}</span>
          <input
            aria-label={tr("files.spreadsheet-formula-bar")}
            class="spreadsheet-editor__formula-input"
            value={selectedValue()}
            readOnly={props.readOnly}
            onFocus={() => setSelected(selected())}
            onInput={(event) => updateCell(selected().row, selected().column, event.currentTarget.value)}
          />
        </div>
        <div class="spreadsheet-editor__sheet-tabs" role="tablist" aria-label={tr("files.spreadsheet-sheets")}>
          <For each={sheetNames()}>
            {(name) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeSheet() === name}
                class="spreadsheet-editor__sheet-tab"
                data-active={activeSheet() === name ? "true" : "false"}
                onClick={() => selectSheet(name)}
              >
                {name}
              </button>
            )}
          </For>
        </div>
        <div class="spreadsheet-editor__surface">
          <table class="spreadsheet-editor__table">
            <thead>
              <tr>
                <th class="spreadsheet-editor__corner" />
                <For each={rows()[0] ?? []}>{(_, column) => <th scope="col">{columnLabel(column())}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row, rowIndex) => (
                  <tr>
                    <th scope="row">{rowIndex() + 1}</th>
                    <For each={row}>
                      {(value, columnIndex) => (
                        <td
                          data-selected={
                            selected().row === rowIndex() && selected().column === columnIndex() ? "true" : "false"
                          }
                        >
                          <input
                            aria-label={`${columnLabel(columnIndex())}${rowIndex() + 1}`}
                            value={value}
                            readOnly={props.readOnly}
                            onFocus={() => setSelected({ row: rowIndex(), column: columnIndex() })}
                            onInput={(event) => updateCell(rowIndex(), columnIndex(), event.currentTarget.value)}
                          />
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  )
}
