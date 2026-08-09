import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { FileTree, FileTreeView } from "./file-tree"

const directory = "C:\\work\\demo"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderTree(backend: ReturnType<typeof createFakeJyycode>, onOpenFile = vi.fn()) {
  vi.stubGlobal("fetch", backend.fetch)
  render(() => (
    <DataProvider
      bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
      generation={0}
      directory={directory}
    >
      <FileTree directory={directory} workspaceID="wrk_main" onOpenFile={onOpenFile} />
    </DataProvider>
  ))
  return onOpenFile
}

describe("FileTree", () => {
  it("loads the root, hides hidden/ignored nodes, and lazy-loads directories", async () => {
    const backend = createFakeJyycode(directory)
    const onOpenFile = renderTree(backend)
    const user = userEvent.setup()

    expect(await screen.findByRole("tree", { name: "项目文件" })).toBeVisible()
    expect(screen.getByRole("button", { name: "src" }).closest("[role=treeitem]")).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.getByRole("treeitem", { name: "README.md" })).toBeVisible()
    expect(screen.queryByRole("treeitem", { name: ".gitignore" })).not.toBeInTheDocument()
    expect(screen.queryByRole("treeitem", { name: "dist" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "src" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "src" }).closest("[role=treeitem]")).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    )
    expect(await screen.findByRole("treeitem", { name: "app.tsx" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "app.tsx" }))
    expect(onOpenFile).toHaveBeenCalledWith({
      path: "src/app.tsx",
      source: "files",
      directory,
      workspaceID: "wrk_main",
    })
    expect(backend.requests.filter((request) => request.path === "/file").map((request) => request.query.path)).toEqual(
      ["", "src"],
    )
  })

  it("supports keyboard directory expansion and selected file state", async () => {
    const backend = createFakeJyycode(directory)
    renderTree(backend)
    const user = userEvent.setup()
    const src = await screen.findByRole("button", { name: "src" })

    src.focus()
    await user.keyboard("{ArrowRight}")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "src" }).closest("[role=treeitem]")).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    )
    expect(await screen.findByRole("treeitem", { name: "app.tsx" })).toHaveAttribute("aria-level", "2")
  })

  it("renders loading, empty, error, and retry states", async () => {
    const retry = vi.fn()
    render(() => <FileTreeView directory={directory} nodes={[]} loading onRetry={retry} onOpenFile={vi.fn()} />)
    expect(screen.getByRole("status")).toHaveTextContent("正在加载文件")
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新文件" }))
    expect(retry).toHaveBeenCalledOnce()

    cleanup()
    render(() => (
      <FileTreeView
        directory={directory}
        nodes={[]}
        error={new Error("network down")}
        onRetry={retry}
        onOpenFile={vi.fn()}
      />
    ))
    expect(screen.getByRole("status")).toHaveTextContent("network down")

    cleanup()
    render(() => <FileTreeView directory={directory} nodes={[]} onOpenFile={vi.fn()} />)
    expect(screen.getByText("此文件夹为空")).toBeVisible()
  })
})
