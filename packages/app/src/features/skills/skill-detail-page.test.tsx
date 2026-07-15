import type { AppSkillsResponse } from "@jyycode-ai/sdk/v2/client"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import { SkillDetailPage } from "./skill-detail-page"

const editable: AppSkillsResponse[number] = {
  name: "editable",
  description: "Editable Skill",
  location: "C:\\skills\\editable\\SKILL.md",
  content: "---\nname: editable\ndescription: Editable Skill\n---\n\n# Safe\n<script>alert(1)</script>",
  origin: "managed",
  editable: true,
  deletable: true,
  revision: "rev-1",
}

function management(skill = editable, update = vi.fn(async () => ({ data: { ...skill, revision: "rev-2" } }))) {
  const queryClient = createDesktopQueryClient()
  const client = {
    app: { skills: vi.fn(async () => ({ data: [skill] })) },
    skill: {
      update,
      delete: vi.fn(async () => ({ data: true })),
      source: { remove: vi.fn(async () => ({ data: true })) },
    },
  }
  return { value: { client, queryClient, directory: "C:\\Users\\test" } as unknown as ManagementContextValue, client }
}

function renderPage(value: ManagementContextValue, name = "editable") {
  const history = createMemoryHistory()
  history.set({ value: `/skills/${name}`, replace: true, scroll: false })
  render(() => (
    <QueryClientProvider client={value.queryClient}>
      <MemoryRouter history={history}>
        <Route path="/skills/:name" component={() => <SkillDetailPage management={value} name={name} />} />
        <Route path="/skills" component={() => <p>list</p>} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

describe("SkillDetailPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    )
    Object.defineProperties(HTMLDialogElement.prototype, {
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.removeAttribute("open")
        },
      },
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.setAttribute("open", "")
        },
      },
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("renders sanitized full Markdown and saves the exact draft with its revision", async () => {
    const user = userEvent.setup()
    const { value, client } = management()
    renderPage(value)

    expect(await screen.findByRole("heading", { name: "Safe" })).toBeVisible()
    expect(document.querySelector("script")).toBeNull()
    await user.click(screen.getByRole("button", { name: "编辑" }))
    const editor = screen.getByRole("textbox", { name: "SKILL.md" })
    expect(editor).toHaveValue(editable.content)
    await user.type(editor, "\nMore")
    await user.keyboard("{Control>}s{/Control}")
    expect(client.skill.update).toHaveBeenCalledWith(
      { directory: value.directory, name: "editable", content: `${editable.content}\nMore`, revision: "rev-1" },
      { throwOnError: true },
    )
  })

  it("hides protected controls and removes URL sources instead of editing cache", async () => {
    const user = userEvent.setup()
    const builtIn = { ...editable, name: "builtin", origin: "built_in" as const, editable: false, deletable: false }
    const built = management(builtIn)
    renderPage(built.value, "builtin")
    expect(await screen.findByRole("heading", { name: "Safe" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument()

    cleanup()
    const remote = {
      ...editable,
      name: "remote",
      origin: "url" as const,
      source: "https://example.com/skills.git",
      editable: false,
    }
    const url = management(remote)
    renderPage(url.value, "remote")
    await user.click(await screen.findByRole("button", { name: "移除来源" }))
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    expect(url.client.skill.source.remove).toHaveBeenCalledWith(
      { directory: url.value.directory, type: "url", value: remote.source },
      { throwOnError: true },
    )
  })

  it("keeps the draft and shows a conflict after a stale revision", async () => {
    const user = userEvent.setup()
    const conflict = Object.assign(new Error("stale"), { name: "SkillConflictError" })
    const update = vi.fn(async () => Promise.reject(conflict))
    const { value } = management(editable, update)
    renderPage(value)
    await user.click(await screen.findByRole("button", { name: "编辑" }))
    const editor = screen.getByRole("textbox", { name: "SKILL.md" })
    await user.type(editor, "\nDraft")
    await user.click(screen.getByRole("button", { name: "保存" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("已被其他操作修改")
    expect(editor).toHaveValue(`${editable.content}\nDraft`)
  })
})
