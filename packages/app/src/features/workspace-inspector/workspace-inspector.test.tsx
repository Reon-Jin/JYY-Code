import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultInspectorPreferences,
  loadInspectorPreferences,
  saveInspectorPreferences,
} from "./inspector-preferences"
import { ResizableSplit } from "./resizable-split"
import { WorkspaceInspectorView } from "./workspace-inspector"

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("workspace inspector preferences", () => {
  it("isolates normalized project directories and clamps persisted ratios", () => {
    saveInspectorPreferences("C:/Work/Demo/", { open: false, todoRatio: 0.95 })
    saveInspectorPreferences("D:/Other", { open: true, todoRatio: 0.1 })

    expect(loadInspectorPreferences("c:\\work\\demo")).toEqual({ open: false, todoRatio: 0.8 })
    expect(loadInspectorPreferences("d:\\other")).toEqual({ open: true, todoRatio: 0.2 })
    expect(localStorage.length).toBe(2)
  })

  it("falls back from damaged or extra persisted fields", () => {
    localStorage.setItem("jyycode:workspace-inspector:c:\\bad", "not-json")
    expect(loadInspectorPreferences("C:\\bad")).toEqual(defaultInspectorPreferences)

    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\partial",
      JSON.stringify({ open: "yes", todoRatio: null, unexpected: true }),
    )
    expect(loadInspectorPreferences("C:\\partial")).toEqual(defaultInspectorPreferences)
  })
})

describe("ResizableSplit", () => {
  it("supports pointer and keyboard ratio changes with separator semantics", async () => {
    const user = userEvent.setup()
    const [ratio, setRatio] = createSignal(0.42)
    render(() => <ResizableSplit value={ratio()} onChange={setRatio} getBounds={() => ({ top: 0, height: 100 })} />)
    const separator = screen.getByRole("separator")

    expect(separator).toHaveAttribute("aria-orientation", "horizontal")
    expect(separator).toHaveAttribute("aria-valuemin", "20")
    expect(separator).toHaveAttribute("aria-valuemax", "80")
    expect(separator).toHaveAttribute("aria-valuenow", "42")

    separator.focus()
    await user.keyboard("{ArrowDown}")
    expect(separator).toHaveAttribute("aria-valuenow", "44")
    await user.keyboard("{ArrowUp}")
    expect(separator).toHaveAttribute("aria-valuenow", "42")
    await user.keyboard("{Home}")
    expect(separator).toHaveAttribute("aria-valuenow", "20")
    await user.keyboard("{End}")
    expect(separator).toHaveAttribute("aria-valuenow", "80")

    fireEvent.pointerDown(separator, { pointerId: 1, clientY: 80 })
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 55 })
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 55 })
    expect(separator).toHaveAttribute("aria-valuenow", "55")
  })
})

describe("WorkspaceInspectorView", () => {
  it("keeps fixed Todo and Changes regions and exposes a discoverable toggle", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(() => (
      <WorkspaceInspectorView
        open
        todoRatio={0.42}
        onOpenChange={onOpenChange}
        onTodoRatioChange={vi.fn()}
        todo={<div>todo content</div>}
        changes={<div>changes content</div>}
      />
    ))

    expect(screen.getByRole("complementary", { name: "工作栏" })).toBeVisible()
    expect(screen.getByRole("region", { name: "Todo" })).toHaveTextContent("todo content")
    expect(screen.getByRole("region", { name: "工作区变更" })).toHaveTextContent("changes content")
    expect(screen.getByRole("separator")).toBeVisible()
    const toggle = screen.getByRole("button", { name: "收起工作栏" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.click(toggle)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
