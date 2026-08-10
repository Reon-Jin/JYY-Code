/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The failure path is `sync.tsx#sync.session.sync` reading
 * `messages.data!` while the SDK leaves `data` undefined on error.
 */
import { describe, expect, test } from "bun:test"
import { Global } from "@jyycode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("does not cache an empty snapshot when the messages endpoint temporarily errors", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      title: "broken",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    let messageRequests = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`) {
        messageRequests += 1
        if (messageRequests === 1) return json({}, { status: 500 })
        return json([
          {
            info: {
              id: "msg_recovered",
              sessionID,
              role: "user",
              time: { created: 1 },
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
      await expect(sync.session.sync(sessionID)).resolves.toBeUndefined()
      expect(sync.data.message[sessionID]).toBeUndefined()

      await expect(sync.session.sync(sessionID)).resolves.toBeUndefined()
      expect(messageRequests).toBe(2)
      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_recovered"])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
