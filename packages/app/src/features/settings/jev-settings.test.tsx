import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import type { ManagementContextValue } from "../management/management-context"
import { JevSettings } from "./jev-settings"

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it("activates Jev and restores legacy mode without exposing the key", async () => {
  const status = vi.fn()
    .mockResolvedValueOnce({ data: { active: false } })
    .mockResolvedValueOnce({ data: { active: true } })
    .mockResolvedValue({ data: { active: false } })
  const client = {
    auth: {
      status,
      set: vi.fn(async () => ({ data: true })),
      remove: vi.fn(async () => ({ data: true })),
    },
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const management = { client, queryClient, directory: "C:\\workspace" } as unknown as ManagementContextValue
  render(() => <QueryClientProvider client={queryClient}><JevSettings management={management} /></QueryClientProvider>)
  const user = userEvent.setup()

  const key = await screen.findByLabelText("Jev API 密钥")
  await user.type(key, "secret-key")
  await user.click(screen.getByRole("button", { name: "激活 Jev API" }))
  await waitFor(() => expect(client.auth.set).toHaveBeenCalledWith(
    { providerID: "typesafe-jev", auth: { type: "api", key: "secret-key" } }, { throwOnError: true },
  ))
  expect(key).toHaveValue("")
  expect(screen.queryByText("secret-key")).not.toBeInTheDocument()
  await user.click(await screen.findByRole("button", { name: "停用 Jev API" }))
  await waitFor(() => expect(client.auth.remove).toHaveBeenCalledWith(
    { providerID: "typesafe-jev" }, { throwOnError: true },
  ))
  expect(client.instance.dispose).toHaveBeenCalledTimes(2)
})
