import { describe, expect, test } from "bun:test"
import { createDialogSessionListQuery, loadDialogSessionList } from "@/cli/cmd/tui/component/dialog-session-list"

describe("dialog session list", () => {
  test("requests roots for default browsing", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/jyycode" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/jyycode",
    })
  })

  test("trims search and limits search results", () => {
    expect(createDialogSessionListQuery({ search: " old task ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
      search: "old task",
      scope: "project",
    })
  })

  test("falls back when loading rejects", async () => {
    const result = await loadDialogSessionList({
      filter: {},
      list: () => Promise.reject(new Error("offline")),
    })
    expect(result).toBeUndefined()
  })
})
