import type { AppSkillsResponse } from "@jyycode-ai/sdk/v2/client"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import { SkillListPage } from "./skill-list-page"

const skills: AppSkillsResponse = [
  {
    id: "url:zeta",
    name: "zeta",
    description: "Remote helper",
    location: "C:\\cache\\zeta\\SKILL.md",
    content: "# Zeta",
    origin: "url",
    source: "https://example.com/skills.git",
    editable: false,
    deletable: true,
    revision: "z1",
  },
  {
    id: "managed:alpha",
    name: "Alpha",
    description: "Local helper",
    location: "C:\\skills\\Alpha\\SKILL.md",
    content: "# Alpha",
    origin: "managed",
    editable: true,
    deletable: true,
    revision: "a1",
  },
]

function management(options?: { data?: AppSkillsResponse; error?: Error }) {
  const queryClient = createDesktopQueryClient()
  const client = {
    app: {
      skills: vi.fn(async () => {
        if (options?.error) throw options.error
        return { data: options?.data ?? skills }
      }),
    },
    skill: {
      create: vi.fn(async () => ({ data: skills[1] })),
      source: { add: vi.fn(async () => ({ data: true })) },
    },
  }
  return { client, queryClient, directory: "C:\\Users\\test" } as unknown as ManagementContextValue
}

function renderPage(value: ManagementContextValue) {
  const history = createMemoryHistory()
  history.set({ value: "/skills", replace: true, scroll: false })
  render(() => (
    <QueryClientProvider client={value.queryClient}>
      <MemoryRouter history={history}>
        <Route path="/skills" component={() => <SkillListPage management={value} />} />
        <Route path="/skills/:name" component={() => <p>selected</p>} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
  return history
}

describe("SkillListPage", () => {
  beforeEach(() => {
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
  afterEach(cleanup)

  it("sorts, labels, searches, and navigates global Skills", async () => {
    const user = userEvent.setup()
    const value = management()
    renderPage(value)

    expect(screen.getByRole("heading", { name: "Skill" })).toBeVisible()
    const rows = await screen.findAllByRole("button", { name: /打开 Skill/ })
    expect(rows[0]).toHaveAccessibleName("打开 Skill Alpha")
    expect(screen.getByText("已管理")).toBeVisible()
    expect(screen.getAllByText("URL")[0]).toBeVisible()

    await user.type(screen.getByRole("searchbox", { name: "搜索 Skill" }), "EXAMPLE.COM")
    expect(screen.queryByRole("button", { name: "打开 Skill Alpha" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "打开 Skill zeta" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "打开 Skill zeta" }))
    expect(await screen.findByText("selected")).toBeVisible()
  })

  it("shows loading, empty, retryable error, create, and source entry points", async () => {
    const user = userEvent.setup()
    const failed = management({ error: new Error("offline") })
    renderPage(failed)

    expect(screen.getByRole("status")).toHaveTextContent("正在加载")
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible()

    cleanup()
    renderPage(management({ data: [] }))
    expect(await screen.findByText("还没有全局 Skill")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "新建" }))
    expect(screen.getByRole("dialog", { name: "新建 Skill" })).toBeVisible()
    cleanup()
    renderPage(management({ data: [] }))
    await user.click(await screen.findByRole("button", { name: "来源" }))
    expect(screen.getByRole("dialog", { name: "添加 Skill 来源" })).toBeVisible()
  })
})
