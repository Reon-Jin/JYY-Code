import * as XLSX from "xlsx"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SpreadsheetEditor, type SpreadsheetEditorSaveInput } from "./spreadsheet-editor"

afterEach(cleanup)

describe("SpreadsheetEditor", () => {
  it("renders and edits a CSV grid, then saves text with the current revision", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async (_input: SpreadsheetEditorSaveInput) => undefined)
    const onDirtyChange = vi.fn()
    const onContentChange = vi.fn()
    render(() => (
      <SpreadsheetEditor
        path="data.csv"
        content={"Name,Amount\nAlice,1"}
        revision="revision-1"
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        onContentChange={onContentChange}
      />
    ))

    const amount = await screen.findByRole("textbox", { name: "B2" })
    expect(amount).toHaveValue("1")
    await user.click(amount)
    await user.keyboard("{Control>}a{/Control}2")

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
    expect(screen.getByRole("button", { name: "保存文件" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "保存文件" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      encoding: undefined,
      revision: "revision-1",
    })
    expect(onSave.mock.calls[0]?.[0].content).toContain("Alice,2")
    expect(onContentChange).toHaveBeenCalled()
  })

  it("exposes workbook sheets and serializes Excel edits as base64", async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Summary"], ["Ready"]]), "Summary")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Details"], ["One"]]), "Details")
    const content = XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) as string
    const onSave = vi.fn(async (_input: SpreadsheetEditorSaveInput) => undefined)
    render(() => (
      <SpreadsheetEditor path="report.xlsx" content={content} encoding="base64" revision="revision-2" onSave={onSave} />
    ))

    expect(await screen.findByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true")
    const details = screen.getByRole("tab", { name: "Details" })
    await userEvent.setup().click(details)
    expect(await screen.findByRole("textbox", { name: "A2" })).toHaveValue("One")
  })
})
