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

  it.each(["plan", "subagents", "blackboard", "changes"] as const)(
    "round-trips the %s pane per normalized project",
    (pane) => {
      saveInspectorPreferences("C:/Work/Demo/", { panes: [pane], ratios: [1], width: 360 })

      expect(loadInspectorPreferences("c:\\work\\demo")).toEqual({ panes: [pane], ratios: [1], width: 360 })
      expect(loadInspectorPreferences("D:\\other")).toEqual({ panes: [], ratios: [], width: 420 })
    },
  )

  it("closes the drawer for malformed values", () => {
    localStorage.setItem("jyycode:workspace-inspector:c:\\bad", "not-json")
    expect(loadInspectorPreferences("C:\\bad")).toEqual({ panes: [], ratios: [], width: 420 })

    localStorage.setItem("jyycode:workspace-inspector:c:\\partial", JSON.stringify({ pane: "unknown" }))
    expect(loadInspectorPreferences("C:\\partial")).toEqual({ panes: [], ratios: [], width: 420 })
  })

  it("migrates the legacy open state and panes to the unified Plan pane", () => {
    localStorage.setItem("jyycode:workspace-inspector:c:\\open", JSON.stringify({ open: true, todoRatio: 0.42 }))
    localStorage.setItem("jyycode:workspace-inspector:c:\\closed", JSON.stringify({ open: false, todoRatio: 0.8 }))
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\legacy",
      JSON.stringify({ panes: ["todo", "multi-agent", "changes"], ratios: [1, 2], width: 500 }),
    )
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\legacy-single",
      JSON.stringify({ pane: "multi-agent", width: 360 }),
    )

    expect(loadInspectorPreferences("C:\\open")).toEqual({ panes: ["plan"], ratios: [1], width: 420 })
    expect(loadInspectorPreferences("C:\\closed")).toEqual({ panes: [], ratios: [], width: 420 })
    expect(loadInspectorPreferences("C:\\legacy")).toEqual({
      panes: ["plan", "changes"],
      ratios: [1 / 3, 2 / 3],
      width: 500,
    })
    expect(loadInspectorPreferences("C:\\legacy-single")).toEqual({ panes: ["plan"], ratios: [1], width: 360 })
  })

  it("normalizes ordered panes, ratios, and duplicate values", () => {
    localStorage.setItem(
      "jyycode:workspace-inspector:c:\\stack",
      JSON.stringify({ panes: ["changes", "plan", "changes", "bad"], ratios: [2, 1], width: 500 }),
    )
    expect(loadInspectorPreferences("C:\\stack")).toEqual({
      panes: ["changes", "plan"],
      ratios: [2 / 3, 1 / 3],
      width: 500,
    })
  })
})

function InspectorHarness(props: { initial?: InspectorPane; badge?: string; blackboardBadge?: string }) {
  const [preferences, setPreferences] = createSignal({
    panes: props.initial ? [props.initial] : [],
    ratios: props.initial ? [1] : [],
    width: 420,
  })
  return (
    <WorkspaceInspectorView
      preferences={preferences()}
      onPreferencesChange={setPreferences}
      plan={<div>plan content</div>}
      blackboard={<div>blackboard content</div>}
      subagents={<div>subagents content</div>}
      changes={<div>changes content</div>}
      files={<div>files content</div>}
      planBadge={props.badge}
      blackboardBadge={props.blackboardBadge}
    />
  )
}

describe("WorkspaceInspectorView", () => {
  it("opens the project files pane without changing legacy pane preferences", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness />)

    const files = screen.getByRole("button", { name: "文件" })
    await user.click(files)

    expect(files).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("group", { name: "文件" })).toHaveTextContent("files content")
  })

  it("keeps the activity rail visible and stacks pages in click order", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness />)

    expect(screen.getByRole("navigation", { name: "工作栏页面" })).toBeVisible()
    const plan = screen.getByRole("button", { name: "方案" })
    const changes = screen.getByRole("button", { name: "工作区变更" })
    expect(plan).toBeVisible()
    expect(changes).toBeVisible()
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()

    await user.click(plan)
    expect(plan).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("group", { name: "方案" })).toHaveTextContent("plan content")

    await user.click(changes)
    expect(screen.getByRole("group", { name: "方案" })).toHaveTextContent("plan content")
    expect(screen.getByRole("group", { name: "工作区变更" })).toHaveTextContent("changes content")
    const regions = screen.getAllByRole("group")
    expect(regions[0]).toHaveAccessibleName("方案")
    expect(regions[1]).toHaveAccessibleName("工作区变更")
    expect(screen.getByRole("separator", { name: "调整 方案 高度" })).toBeVisible()

    await user.click(changes)
    expect(changes).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("group", { name: "方案" })).toBeVisible()
  })

  it("opens the blackboard pane and keeps its unread badge out of the accessible name", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness blackboardBadge="4" />)

    const blackboard = screen.getByRole("button", { name: "协作黑板" })
    expect(blackboard).toBeVisible()
    expect(screen.getByText("4")).toHaveAttribute("aria-hidden", "true")
    await user.click(blackboard)
    expect(screen.getByRole("group", { name: "协作黑板" })).toHaveTextContent("blackboard content")
    expect(screen.getByRole("button", { name: "协作黑板" })).toHaveAttribute("aria-pressed", "true")
  })

  it("opens the subagents pane after Plan and keeps it keyboard-addressable", async () => {
    const user = userEvent.setup()
    render(() => <InspectorHarness />)

    const subagents = screen.getByRole("button", { name: "子 Agent" })
    expect(subagents).toBeVisible()
    await user.click(subagents)
    expect(subagents).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("group", { name: "子 Agent" })).toHaveTextContent("subagents content")
  })

  it("closes an overlay drawer with Escape at narrow width", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true }) as MediaQueryList),
    })
    render(() => <InspectorHarness initial="plan" />)
    expect(screen.getByRole("group", { name: "方案" })).toBeVisible()

    fireEvent.keyDown(window, { key: "Escape" })

    expect(screen.queryByRole("group", { name: "方案" })).not.toBeInTheDocument()
  })

  it("keeps badge text out of the icon button accessible name", () => {
    render(() => <InspectorHarness badge="3 running" />)

    expect(screen.getByRole("button", { name: "方案" })).toBeVisible()
    expect(screen.queryByRole("button", { name: /3 running/ })).not.toBeInTheDocument()
    expect(screen.getByText("3 running")).toHaveAttribute("aria-hidden", "true")
  })

  it("supports keyboard resizing for the drawer width and stacked pane boundary", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 })
    const user = userEvent.setup()
    const { container } = render(() => <InspectorHarness initial="plan" />)
    await user.click(screen.getByRole("button", { name: "工作区变更" }))

    const widthHandle = screen.getByRole("separator", { name: "调整工作栏宽度" })
    expect(widthHandle).toHaveAttribute("aria-valuenow", "420")
    fireEvent.keyDown(widthHandle, { key: "ArrowLeft" })
    expect(widthHandle).toHaveAttribute("aria-valuenow", "440")

    const stack = container.querySelector<HTMLElement>(".workspace-drawer__stack")!
    expect(stack.style.gridTemplateRows).toContain("0.5fr")
    fireEvent.keyDown(screen.getByRole("separator", { name: "调整 方案 高度" }), { key: "ArrowDown" })
    expect(stack.style.gridTemplateRows).toContain("0.55fr")
  })

  it("previews pointer width changes and persists only when dragging ends", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 })
    const onPreferencesChange = vi.fn()
    const { container } = render(() => (
      <div class="workspace-shell">
        <WorkspaceInspectorView
          preferences={{ panes: ["plan"], ratios: [1], width: 420 }}
          onPreferencesChange={onPreferencesChange}
          plan={<div>plan content</div>}
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
    expect(onPreferencesChange).toHaveBeenCalledWith({ panes: ["plan"], ratios: [1], width: 480 })
    expect(shell).not.toHaveAttribute("data-inspector-resizing")
  })
})
