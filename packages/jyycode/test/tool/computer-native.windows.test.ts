import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Global } from "@jyycode-ai/core/global"
import { runNative, toDesktopAction } from "@/tool/computer/native"
import { stopWindows } from "@/tool/computer/windows-worker"
import { createZoom } from "@/tool/computer/zoom"

// Opt-in: briefly moves the real pointer, never clicks, and restores its original position.
test.skipIf(process.platform !== "win32" || process.env.JYYCODE_COMPUTER_NATIVE_TEST !== "1")(
  "native screenshot, zoom and input agree on physical pixels and stop removes the helper",
  async () => {
    const first = await runNative({ action: "observe", captureRaw: true })
    const original = first.observation.cursor
    const screen = first.observation.screen
    try {
      const samples: unknown[] = []
      for (const fraction of [0.2, 0.5, 0.8]) {
        const x = Math.floor(first.observation.image.width * fraction)
        const y = Math.floor(first.observation.image.height * fraction)
        const input = toDesktopAction({ action: "move", x, y }, first.observation)
        const result = await runNative(input)
        if (input.action !== "move") throw new Error("Expected move")
        expect(result.observation.inputCursor).toEqual({ x: input.x!, y: input.y! })
        samples.push({ image: { x, y }, desktop: result.observation.inputCursor })
      }
      const raw = first.observation.rawImage!
      const zoom = await createZoom(first.rawPng!, first.observation, {
        x: Math.floor(raw.width / 2),
        y: Math.floor(raw.height / 2),
      })
      const input = toDesktopAction(
        {
          action: "move",
          x: Math.floor(zoom.observation.image.width / 2),
          y: Math.floor(zoom.observation.image.height / 2),
        },
        zoom.observation,
      )
      const result = await runNative(input)
      expect(result.observation.inputCursor).toEqual({
        x: screen.x + Math.floor(screen.width / 2),
        y: screen.y + Math.floor(screen.height / 2),
      })
      console.log(
        JSON.stringify({
          screen,
          image: first.observation.image,
          monitors: first.observation.monitors,
          samples,
          zoomCenter: result.observation.inputCursor,
        }),
      )
    } finally {
      try {
        await runNative({ action: "move", ...original })
      } finally {
        await stopWindows()
      }
    }
    expect(
      (await readdir(Global.Path.tmp)).filter(
        (name) => name.startsWith("computer-worker-") || name.startsWith("computer-frame-"),
      ),
    ).toEqual([])
  },
  30_000,
)
