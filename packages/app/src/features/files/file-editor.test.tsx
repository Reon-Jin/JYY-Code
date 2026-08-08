import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileEditor, languageExtension } from "./file-editor"

afterEach(cleanup)

describe("FileEditor", () => {
  it("loads language-aware editing, tracks dirty state, and saves with Ctrl+S", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const onDirtyChange = vi.fn()
    render(() => (
      <FileEditor
        path="src/app.tsx"
        content="const safe = false"
        revision="revision-1"
        onSave={onSave}
        onDirtyChange={onDirtyChange}
      />
    ))

    const editor = screen.getByRole("textbox")
    editor.focus()
    await user.keyboard("{Control>}a{/Control}")
    await user.keyboard("const safe = true")

    expect(screen.getByRole("button", { name: "Save file" })).toBeEnabled()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ content: "const safe = true", revision: "revision-1" }))
  })

  it("keeps a local draft when external content changes", async () => {
    const user = userEvent.setup()
    const onExternalChange = vi.fn()
    const [content, setContent] = createSignal("const safe = false")
    const onContentChange = vi.fn((value: string) => setContent(value))
    render(() => (
      <FileEditor
        path="src/app.tsx"
        content={content()}
        revision="revision-1"
        onContentChange={onContentChange}
        onExternalChange={onExternalChange}
      />
    ))

    const editor = screen.getByRole("textbox")
    editor.focus()
    await user.keyboard("{Control>}a{/Control}")
    await user.keyboard("const draft = true")
    await waitFor(() => expect(onContentChange).toHaveBeenCalled())
    expect(onExternalChange).not.toHaveBeenCalled()
    setContent("const external = true")

    await waitFor(() => expect(onExternalChange).toHaveBeenCalled())
    expect(editor).toHaveTextContent("const draft = true")
    expect(editor).not.toHaveTextContent("const external = true")
  })

  it("returns a CodeMirror extension for supported languages and plain text fallback", () => {
    expect(languageExtension("src/app.tsx")).toBeTruthy()
    expect(languageExtension("README.md")).toBeTruthy()
    expect(languageExtension("notes.unknown")).toEqual([])
  })
})
