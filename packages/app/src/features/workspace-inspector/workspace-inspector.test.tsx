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
    expect(loadInspectorPreferences("C:\\fresh")).toEqual({ pane: undefined })
    expect(defaultInspectorPreferences).toEqual({ pane: undefined })
  })

  it.each(["todo", "multi-agent", "changes"] as const)("round-trips the %s pane per normalized project", (pane) => {
    saveInspectorPreferences("C:/Work/Demo/", { pane })

    expect(loadInspectorPreferences("c:\\work\\demo")).toEqual({ pane })
    expect(loadInspectorPreferences("D:\\other")).toEqual({ pane: undefined })
  })

  it("closes the drawer for malformed values", () => {
    localStorage.setItem("jyycode:workspace-inspector:c:\\bad", "not-json")
    expect(loadInspectorPreferences("C:\\bad")).toEqual({ pane: undefined })

    localStorage.setItem("jyycode:workspace-inspector:c:\\partial", JSON.stringify({ pane: "unknown" }))
    expect(loadInspectorPreferences("C:\\partial")).toEqual({ pane: undefined })
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

    expect(loadInspectorPreferences("C:\\open")).toEqual({ pane: "todo" })
    expect(loadInspectorPreferences("C:\\closed")).toEqual({ pane: undefined })
  })
})

function InspectorHarness(props: { initial?: InspectorPane; badge?: string }) {
  const [pane, setPane] = createSignal<InspectorPane | undefined>(props.initial)
  return (
    <WorkspaceInspectorView
      pane={pane()}
      onPaneChange={setPane}
      todo={<div>todo content</div>}
      multiAgent={<div>cluster content</div>}
      changes={<div>changes content</div>}
      multiAgentBadge={props.badge}
    />
  )
}

describe("WorkspaceInspectorView", () => {
  it("keeps the activity rail visible and mounts exactly one controlled drawer page", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness />)

    expect(screen.getByRole("navigation", { name: "工作栏页面" })).toBeVisible()
    const todo = screen.getByRole("button", { name: "Todo" })
    const multiAgent = screen.getByRole("button", { name: "Multi-Agent" })
    const changes = screen.getByRole("button", { name: "工作区变更" })
    expect(todo).toBeVisible()
    expect(multiAgent).toBeVisible()
    expect(changes).toBeVisible()
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()

    await user.click(todo)
    expect(todo).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("complementary", { name: "Todo" })).toHaveTextContent("todo content")

    await user.click(changes)
    expect(screen.queryByRole("complementary", { name: "Todo" })).not.toBeInTheDocument()
    expect(screen.getByRole("complementary", { name: "工作区变更" })).toHaveTextContent("changes content")

    await user.click(changes)
    expect(changes).toHaveAttribute("aria-pressed", "false")
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  it("closes an overlay drawer with Escape at narrow width", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true } as MediaQueryList)),
    })
    render(() => <InspectorHarness initial="multi-agent" />)
    expect(screen.getByRole("complementary", { name: "Multi-Agent" })).toBeVisible()

    fireEvent.keyDown(window, { key: "Escape" })

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  it("keeps badge text out of the icon button accessible name", () => {
    render(() => <InspectorHarness badge="3 running" />)

    expect(screen.getByRole("button", { name: "Multi-Agent" })).toBeVisible()
    expect(screen.queryByRole("button", { name: /3 running/ })).not.toBeInTheDocument()
    expect(screen.getByText("3 running")).toHaveAttribute("aria-hidden", "true")
  })
})
