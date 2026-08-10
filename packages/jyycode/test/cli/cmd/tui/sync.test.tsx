/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@jyycode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@jyycode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/jyycode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("refreshes session data after the server instance is disposed", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_disposed"
    const sessionPayload = {
      id: sessionID,
      title: "disposed",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    let messageRequests = 0
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`) {
        messageRequests += 1
        return json([
          {
            info: {
              id: messageRequests === 1 ? "msg_before_dispose" : "msg_after_dispose",
              sessionID,
              role: "user",
              time: { created: messageRequests },
            },
            parts: [],
          },
        ])
      }
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      if (url.pathname === `/session/${sessionID}/context`) return json({})
      if (url.pathname === "/session") return json([sessionPayload])
      return undefined
    })

    try {
      await sync.session.sync(sessionID)
      expect(messageRequests).toBe(1)

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_disposed",
          type: "server.instance.disposed",
          properties: { directory },
        },
      })
      await sync.session.sync(sessionID)

      expect(messageRequests).toBe(2)
      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_after_dispose"])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
