import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  defaultInspectorPreferences,
  loadInspectorPreferences,
  saveInspectorPreferences,
  type InspectorPane,
} from "./inspector-preferences"
import { WorkspaceInspectorView } from "./workspace-inspector"

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("workspace inspector preferences", () => {
  it("defaults a fresh project to a closed drawer", () => {
    expect(loadInspectorPreferences("C:\\fresh")).toEqual({ panes: [], ratios: [], width: 420 })
    expect(defaultInspectorPreferences).toEqual({ panes: [], ratios: [], width: 420 })
  })

  it.each(["todo", "multi-agent", "changes"] as const)("round-trips the %s pane per normalized project", (pane) => {
    saveInspectorPreferences("C:/Work/Demo/", { panes: [pane], ratios: [1], width: 360 })

    expect(loadInspectorPreferences("c:\\work\\demo")).toEqual({ panes: [pane], ratios: [1], width: 360 })
    expect(loadInspectorPreferences("D:\\other")).toEqual({ panes: [], ratios: [], width: 420 })
  })

  it("closes the drawer for malformed values", () => {
    localStorage.setItem("jyycode:workspace-inspector:c:\\bad", "not-json")
    expect(loadInspectorPreferences("C:\\bad")).toEqual({ panes: [], ratios: [], width: 420 })

    localStorage.setItem("jyycode:workspace-inspector:c:\\partial", JSON.stringify({ pane: "unknown" }))
    expect(loadInspectorPreferences("C:\\partial")).toEqual({ panes: [], ratios: [], width: 420 })
  })

  it("migrates the legacy open state to Todo and legacy closed state to no pane", () => {
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\open",
      JSON.stringify({ open: true, todoRatio: 0.42 }),
    )
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\closed",
      JSON.stringify({ open: false, todoRatio: 0.8 }),
    )

    expect(loadInspectorPreferences("C:\\open")).toEqual({ panes: ["todo"], ratios: [1], width: 420 })
    expect(loadInspectorPreferences("C:\\closed")).toEqual({ panes: [], ratios: [], width: 420 })
  })

  it("normalizes ordered panes, ratios, and duplicate values", () => {
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\stack",
      JSON.stringify({ panes: ["changes", "todo", "changes", "bad"], ratios: [2, 1], width: 500 }),
    )
    expect(loadInspectorPreferences("C:\\stack")).toEqual({
      panes: ["changes", "todo"],
      ratios: [2 / 3, 1 / 3],
      width: 500,
    })
  })
})

function InspectorHarness(props: { initial?: InspectorPane; badge?: string }) {
  const [preferences, setPreferences] = createSignal({
    panes: props.initial ? [props.initial] : [],
    ratios: props.initial ? [1] : [],
    width: 420,
  })
  return (
    <WorkspaceInspectorView
      preferences={preferences()}
      onPreferencesChange={setPreferences}
      todo={<div>todo content</div>}
      multiAgent={<div>cluster content</div>}
      changes={<div>changes content</div>}
      multiAgentBadge={props.badge}
    />
  )
}

describe("WorkspaceInspectorView", () => {
  it("keeps the activity rail visible and stacks pages in click order", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness />)

    expect(screen.getByRole("navigation", { name: "工作栏页面" })).toBeVisible()
    const todo = screen.getByRole("button", { name: "待办" })
    const multiAgent = screen.getByRole("button", { name: "多智能体" })
    const changes = screen.getByRole("button", { name: "工作区变更" })
    expect(todo).toBeVisible()
    expect(multiAgent).toBeVisible()
    expect(changes).toBeVisible()
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()

    await user.click(todo)
    expect(todo).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("group", { name: "待办" })).toHaveTextContent("todo content")

    await user.click(changes)
    expect(screen.getByRole("group", { name: "待办" })).toHaveTextContent("todo content")
    expect(screen.getByRole("group", { name: "工作区变更" })).toHaveTextContent("changes content")
    const regions = screen.getAllByRole("group")
    expect(regions[0]).toHaveAccessibleName("待办")
    expect(regions[1]).toHaveAccessibleName("工作区变更")
    expect(screen.getByRole("separator", { name: "调整 待办 高度" })).toBeVisible()

    await user.click(changes)
    expect(changes).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("group", { name: "待办" })).toBeVisible()
  })

  it("closes an overlay drawer with Escape at narrow width", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true } as MediaQueryList)),
    })
    render(() => <InspectorHarness initial="multi-agent" />)
    expect(screen.getByRole("group", { name: "多智能体" })).toBeVisible()

    fireEvent.keyDown(window, { key: "Escape" })

    expect(screen.queryByRole("group", { name: "多智能体" })).not.toBeInTheDocument()
  })

  it("keeps badge text out of the icon button accessible name", () => {
    render(() => <InspectorHarness badge="3 running" />)

    expect(screen.getByRole("button", { name: "多智能体" })).toBeVisible()
    expect(screen.queryByRole("button", { name: /3 running/ })).not.toBeInTheDocument()
    expect(screen.getByText("3 running")).toHaveAttribute("aria-hidden", "true")
  })

  it("supports keyboard resizing for the drawer width and stacked pane boundary", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 })
    const user = userEvent.setup()
    const { container } = render(() => <InspectorHarness initial="todo" />)
    await user.click(screen.getByRole("button", { name: "工作区变更" }))

    const widthHandle = screen.getByRole("separator", { name: "调整工作栏宽度" })
    expect(widthHandle).toHaveAttribute("aria-valuenow", "420")
    fireEvent.keyDown(widthHandle, { key: "ArrowLeft" })
    expect(widthHandle).toHaveAttribute("aria-valuenow", "440")

    const stack = container.querySelector<HTMLElement>(".workspace-drawer__stack")!
    expect(stack.style.gridTemplateRows).toContain("0.5fr")
    fireEvent.keyDown(screen.getByRole("separator", { name: "调整 待办 高度" }), { key: "ArrowDown" })
    expect(stack.style.gridTemplateRows).toContain("0.55fr")
  })

  it("previews pointer width changes and persists only when dragging ends", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 })
    const onPreferencesChange = vi.fn()
    const { container } = render(() => (
      <div class="workspace-shell">
        <WorkspaceInspectorView
          preferences={{ panes: ["todo"], ratios: [1], width: 420 }}
          onPreferencesChange={onPreferencesChange}
          todo={<div>todo content</div>}
          multiAgent={<div>cluster content</div>}
          changes={<div>changes content</div>}
        />
      </div>
    ))
    const handle = screen.getByRole("separator", { name: "调整工作栏宽度" })
    const shell = container.querySelector<HTMLElement>(".workspace-shell")!

    fireEvent.pointerDown(handle, { clientX: 600 })
    fireEvent.pointerMove(window, { clientX: 540 })
    expect(onPreferencesChange).not.toHaveBeenCalled()
    expect(shell).toHaveAttribute("data-inspector-resizing", "true")

    fireEvent.pointerUp(window, { clientX: 540 })
    expect(onPreferencesChange).toHaveBeenCalledOnce()
    expect(onPreferencesChange).toHaveBeenCalledWith({ panes: ["todo"], ratios: [1], width: 480 })
    expect(shell).not.toHaveAttribute("data-inspector-resizing")
  })
})
