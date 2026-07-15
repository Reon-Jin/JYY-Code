import type { PermissionRequest } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PermissionBar } from "./permission-bar"

const directory = "C:\\work\\demo"
const request: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["git status"],
  metadata: {},
  always: ["git status", "git diff *"],
}

function renderPermission(reply = vi.fn(async () => ({ data: true }))) {
  const client = { permission: { reply } }
  const [pending, setPending] = createSignal<PermissionRequest | undefined>(request)
  render(() => (
    <Show when={pending()} keyed>
      {(value) => <PermissionBar client={client as never} directory={directory} request={value} />}
    </Show>
  ))
  return { client, setPending }
}

afterEach(cleanup)

describe("PermissionBar", () => {
  it("keeps a permission visible until the server confirms it", async () => {
    const user = userEvent.setup()
    const { client, setPending } = renderPermission()

    await user.click(screen.getByRole("button", { name: "仅本次允许" }))
    expect(client.permission.reply).toHaveBeenCalledWith(
      { directory, requestID: request.id, reply: "once" },
      { throwOnError: true },
    )
    expect(screen.getByRole("region", { name: "权限请求" })).toBeVisible()
    expect(screen.getByRole("status", { name: "权限请求状态" })).toHaveTextContent("等待服务端确认")

    setPending(undefined)
    await waitFor(() => expect(screen.queryByRole("region", { name: "权限请求" })).not.toBeInTheDocument())
  })

  it("confirms always with the backend-provided patterns", async () => {
    const user = userEvent.setup()
    const { client } = renderPermission()

    await user.click(screen.getByRole("button", { name: "始终允许" }))
    expect(screen.getByText("git status")).toBeVisible()
    expect(screen.getByText("git diff *")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "确认始终允许" }))

    expect(client.permission.reply).toHaveBeenCalledWith(
      { directory, requestID: request.id, reply: "always" },
      { throwOnError: true },
    )
  })

  it("rejects with an optional reason", async () => {
    const user = userEvent.setup()
    const { client } = renderPermission()

    await user.click(screen.getByRole("button", { name: "拒绝" }))
    await user.type(screen.getByRole("textbox", { name: "拒绝原因（可选）" }), "命令范围过大")
    await user.click(screen.getByRole("button", { name: "确认拒绝" }))

    expect(client.permission.reply).toHaveBeenCalledWith(
      { directory, requestID: request.id, reply: "reject", message: "命令范围过大" },
      { throwOnError: true },
    )
  })

  it("moves focus only after Handle request is invoked and recovers from reply failures", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => {
      throw new Error("offline")
    })
    renderPermission(reply)
    const once = screen.getByRole("button", { name: "仅本次允许" })
    expect(once).not.toHaveFocus()

    await user.click(screen.getByRole("button", { name: "处理请求" }))
    expect(once).toHaveFocus()
    await user.click(once)
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    expect(once).toBeEnabled()
  })
})
