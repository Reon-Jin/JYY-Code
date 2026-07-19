import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import type { DefaultPermissionMode } from "./default-permission"
import { SecuritySettings } from "./security-settings"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"

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
    path: { get: vi.fn(async () => ({ data: { config: "C:\\Users\\test\\.config\\jyycode" } })) },
  }
  return {
    client,
    queryClient: createDesktopQueryClient(),
    directory: "C:\\Users\\test",
  } as unknown as ManagementContextValue & { client: typeof client }
}

function renderSecurity(value = management()) {
  const desktop = createFakeDesktop()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <QueryClientProvider client={value.queryClient}>
        <SecuritySettings management={value} />
      </QueryClientProvider>
    </DesktopBridgeProvider>
  ))
  return value
}

beforeEach(installDialog)
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("SecuritySettings", () => {
  it("keeps permission controls locked while saving without exposing a saving message", async () => {
    const value = management()
    let finish!: (result: { data: { mode: "request" } }) => void
    value.client.global.defaultPermission.update.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve }),
    )
    renderSecurity(value)

    const request = await screen.findByRole("radio", { name: "每次询问" })
    await userEvent.setup().click(request)

    await waitFor(() => expect(request).toBeDisabled())
    expect(screen.queryByText("正在保存…")).not.toBeInTheDocument()

    finish({ data: { mode: "request" } })
    await waitFor(() => expect(request).toBeEnabled())
  })

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
    const card = screen.getByRole("region", { name: "新 Session 默认权限" })
    expect(within(card).getByText(/仅应用于新建的 Session/)).toBeVisible()
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
