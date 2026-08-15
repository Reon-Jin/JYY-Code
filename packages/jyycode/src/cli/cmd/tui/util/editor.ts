import { defer } from "@/util/defer"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliRenderer } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { AppProcess } from "@jyycode-ai/core/process"
import { Effect } from "effect"

export async function open(opts: { value: string; renderer: CliRenderer }): Promise<string | undefined> {
  const editor = process.env["VISUAL"] || process.env["EDITOR"]
  if (!editor) return

  const filepath = join(tmpdir(), `${Date.now()}.md`)
  await using _ = defer(async () => rm(filepath, { force: true }))

  await Filesystem.write(filepath, opts.value)
  opts.renderer.suspend()
  opts.renderer.currentRenderBuffer.clear()
  try {
    const parts = editor.split(" ")
    await Effect.runPromise(
      AppProcess.Service.use((appProcess) =>
        appProcess.run({
          command: parts[0]!,
          args: [...parts.slice(1), filepath],
          env: { mode: "inherit-allowlist" },
          output: "inherit",
          ...(process.platform === "win32" ? { shell: true } : {}),
        }),
      ).pipe(Effect.provide(AppProcess.defaultLayer)),
    )
    const content = await Filesystem.readText(filepath)
    return content || undefined
  } finally {
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
  }
}

export * as Editor from "./editor"
