import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { filePreviewPath } from "../../src/server/shared/file-preview-routing"
import * as Log from "@jyycode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>, init?: RequestInit) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "x-jyycode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toContainEqual({ path: "hello.txt", added: 1, removed: 0, status: "added" })
  })

  test("serves media through bounded range responses", async () => {
    await using tmp = await tmpdir({ git: false })
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    await Bun.write(path.join(tmp.path, "clip.mp4"), bytes)

    const response = await request("/file/raw", tmp.path, { path: "clip.mp4" }, { headers: { range: "bytes=2-6" } })

    expect(response.status).toBe(206)
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("content-range")).toBe("bytes 2-6/10")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([2, 3, 4, 5, 6]))
  })

  test("serves project resources through browser preview paths", async () => {
    await using tmp = await tmpdir({ git: false })
    await Bun.write(path.join(tmp.path, "index.html"), "<link rel=stylesheet href=./styles.css>")
    await Bun.write(path.join(tmp.path, "styles.css"), "body { color: red; }")

    const route = filePreviewPath({ directory: tmp.path, authToken: "preview-token", path: "index.html" })
    const page = await request(route, tmp.path)
    const styles = await request(route.replace("index.html", "styles.css"), tmp.path)

    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("styles.css")
    expect(styles.status).toBe(200)
    expect(await styles.text()).toContain("color: red")
  })

  test("returns small PPTX files as previewable binary content", async () => {
    await using tmp = await tmpdir({ git: false })
    await Bun.write(path.join(tmp.path, "slides.pptx"), new Uint8Array(77 * 1024))

    const response = await request(FilePaths.content, tmp.path, { path: "slides.pptx" })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ type: "text", encoding: "base64" })
    expect(body.content.length).toBeGreaterThan(0)
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, files, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.status).toBe(200)
    expect(await files.json()).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })

  test("writes scoped UTF-8 content and reports revision conflicts", async () => {
    await using tmp = await tmpdir({ git: false })
    await Bun.write(path.join(tmp.path, "editable.txt"), "before")

    const current = await request(FilePaths.content, tmp.path, { path: "editable.txt" })
    const currentBody = await current.json()
    const saved = await request(FilePaths.content, tmp.path, undefined, {
      method: "PUT",
      body: JSON.stringify({ path: "editable.txt", content: "after\n", revision: currentBody.revision }),
      headers: { "content-type": "application/json" },
    })

    expect(saved.status).toBe(200)
    expect((await saved.json()).revision).toBeTruthy()

    const conflict = await request(FilePaths.content, tmp.path, undefined, {
      method: "PUT",
      body: JSON.stringify({ path: "editable.txt", content: "stale", revision: currentBody.revision }),
      headers: { "content-type": "application/json" },
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ name: "FileConflictError" })
  })

  test("writes scoped base64 spreadsheet content", async () => {
    await using tmp = await tmpdir({ git: false })
    const before = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])
    const after = Uint8Array.from([0x50, 0x4b, 0x05, 0x06])
    await Bun.write(path.join(tmp.path, "report.xlsx"), before)

    const current = await request(FilePaths.content, tmp.path, { path: "report.xlsx" })
    const currentBody = await current.json()
    const saved = await request(FilePaths.content, tmp.path, undefined, {
      method: "PUT",
      body: JSON.stringify({
        path: "report.xlsx",
        content: Buffer.from(after).toString("base64"),
        encoding: "base64",
        revision: currentBody.revision,
      }),
      headers: { "content-type": "application/json" },
    })

    expect(saved.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "report.xlsx")).arrayBuffer()).toEqual(after.buffer)
  })

  test("writes scoped base64 PDF content", async () => {
    await using tmp = await tmpdir({ git: false })
    const before = Buffer.from("%PDF-1.4 before")
    const after = Buffer.from("%PDF-1.4 after")
    await Bun.write(path.join(tmp.path, "annotated.pdf"), before)

    const current = await request(FilePaths.content, tmp.path, { path: "annotated.pdf" })
    const currentBody = await current.json()
    const saved = await request(FilePaths.content, tmp.path, undefined, {
      method: "PUT",
      body: JSON.stringify({
        path: "annotated.pdf",
        content: after.toString("base64"),
        encoding: "base64",
        revision: currentBody.revision,
      }),
      headers: { "content-type": "application/json" },
    })

    expect(saved.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "annotated.pdf")).arrayBuffer()).toEqual(after.buffer)
  })
})
