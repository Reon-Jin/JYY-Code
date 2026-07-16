import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import type { DefaultPermissionMode } from "./default-permission"
import { SecuritySettings } from "./security-settings"

function installDialog() {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")) } },
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } },
  })
}

function management(initial: DefaultPermissionMode = "auto") {
  let mode = initial
  const client = {
    global: {
      defaultPermission: {
        get: vi.fn(async () => ({ data: { mode } })),
        update: vi.fn(async ({ mode: next }: { mode: Exclude<DefaultPermissionMode, "custom"> }) => {
          mode = next
          return { data: { mode } }
        }),
      },
    },
    session: { update: vi.fn() },
  }
  return {
    client,
    queryClient: createDesktopQueryClient(),
    directory: "C:\\Users\\test",
  } as unknown as ManagementContextValue & { client: typeof client }
}

function renderSecurity(value = management()) {
  render(() => (
    <QueryClientProvider client={value.queryClient}>
      <SecuritySettings management={value} />
    </QueryClientProvider>
  ))
  return value
}

beforeEach(installDialog)
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("SecuritySettings", () => {
  it("updates the default for new Sessions without touching the current Session", async () => {
    const value = renderSecurity()

    await userEvent.setup().click(await screen.findByRole("radio", { name: "每次询问" }))

    await waitFor(() =>
      expect(value.client.global.defaultPermission.update).toHaveBeenCalledWith(
        { mode: "request" },
        { throwOnError: true },
      ),
    )
    expect(value.client.session.update).not.toHaveBeenCalled()
    expect(screen.getByText(/仅应用于新建的 Session/)).toBeVisible()
  })

  it("rolls back the selected policy when saving fails", async () => {
    const value = management()
    value.client.global.defaultPermission.update.mockRejectedValueOnce(new Error("permission save failed"))
    renderSecurity(value)

    await userEvent.setup().click(await screen.findByRole("radio", { name: "每次询问" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("permission save failed"))
    expect(screen.getByRole("radio", { name: "自动" })).toBeChecked()
  })

  it("requires confirmation before replacing custom rules", async () => {
    const value = renderSecurity(management("custom"))

    await userEvent.setup().click(await screen.findByRole("radio", { name: "完全访问" }))

    const dialog = await screen.findByRole("dialog", { name: "替换自定义权限" })
    expect(value.client.global.defaultPermission.update).not.toHaveBeenCalled()
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "替换并继续" }))
    await waitFor(() => expect(value.client.global.defaultPermission.update).toHaveBeenCalledWith(
      { mode: "full" },
      { throwOnError: true },
    ))
  })
})
