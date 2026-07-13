import type { GlobalEvent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { ChangesPanel, ChangesPanelView } from "./changes-panel"

const directory = "C:\\work\\demo"
const changes: VcsFileDiff[] = [
  {
    file: "src/app.ts",
    status: "modified",
    additions: 4,
    deletions: 2,
    patch: "@@ -1 +1 @@\n-const safe = false\n+const safe = true\n",
  },
  { file: "assets/image.png", status: "added", additions: 3, deletions: 0 },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ChangesPanel", () => {
  it("summarizes files and renders only the selected text diff", async () => {
    const user = userEvent.setup()
    render(() => <ChangesPanelView directory={directory} changes={changes} />)

    expect(screen.getByText("2 个文件")).toBeVisible()
    expect(screen.getByText("+7 -2")).toBeVisible()
    const first = screen.getByRole("button", { name: /src\/app\.ts/ })
    const second = screen.getByRole("button", { name: /assets\/image\.png/ })
    expect(first).toHaveAttribute("aria-expanded", "true")
    expect(second).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("const safe = true")).toBeVisible()
    expect(screen.queryByText("二进制文件或无可显示文本 Diff")).not.toBeInTheDocument()

    await user.click(second)
    expect(first).toHaveAttribute("aria-expanded", "false")
    expect(second).toHaveAttribute("aria-expanded", "true")
    expect(screen.queryByText("const safe = true")).not.toBeInTheDocument()
    expect(screen.getByText("二进制文件或无可显示文本 Diff")).toBeVisible()
    expect(screen.queryByText(/last-turn/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Session$/i)).not.toBeInTheDocument()
  })

  it("shows a compact clean-worktree state", () => {
    render(() => <ChangesPanelView directory={directory} changes={[]} />)
    expect(screen.getByText("工作区没有未提交变更")).toBeVisible()
  })

  it("refreshes on file events and keeps the selected file when it still exists", async () => {
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <ChangesPanel directory={directory} />
      </DataProvider>
    ))

    const selected = await screen.findByRole("button", { name: /src\/app\.tsx/ })
    expect(selected).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("1 个文件")).toBeVisible()

    backend.changes.push({ file: "src/new.ts", status: "added", additions: 2, deletions: 0, patch: "+new" })
    backend.emit({
      id: "event_file_change",
      type: "file.watcher.updated",
      properties: { file: "src/new.ts", event: "add" },
    } as GlobalEvent["payload"])

    await waitFor(() => expect(screen.getByText("2 个文件")).toBeVisible())
    expect(screen.getByRole("button", { name: /src\/app\.tsx/ })).toHaveAttribute("aria-expanded", "true")
  })
})
