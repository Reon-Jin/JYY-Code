import { existsSync, readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"

const indexHTML = readFileSync("index.html", "utf8")
const entrySource = readFileSync("src/index.tsx", "utf8")
const routesSource = readFileSync("src/routes.tsx", "utf8")
const watchdogPath = "public/startup-watchdog.js"
const watchdogSource = existsSync(watchdogPath) ? readFileSync(watchdogPath, "utf8") : ""

afterEach(() => {
  window.dispatchEvent(new Event("jyycode:frontend-mounted"))
  sessionStorage.clear()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe("desktop startup shell", () => {
  it("paints a branded loading state before JavaScript is ready", () => {
    expect(indexHTML).toContain('data-startup-shell="true"')
    expect(indexHTML).toContain("正在启动 JYYCode")
    expect(indexHTML).toMatch(/html,\s*body,\s*#root\s*\{[^}]*background:\s*#efede7;/s)
    expect(entrySource).toContain("root.replaceChildren()")
  })

  it("recovers when the frontend entry module never mounts", () => {
    expect(indexHTML).toMatch(
      /<script vite-ignore src="\.\/startup-watchdog\.js"><\/script>[\s\S]*<script type="module" src="\/src\/index\.tsx"><\/script>/,
    )
    expect(watchdogSource).toContain("window.setTimeout")
    expect(watchdogSource).toContain("window.location.reload()")
    expect(watchdogSource).toContain("sessionStorage")
    expect(watchdogSource).toContain("界面加载失败")
    expect(entrySource).toContain('window.dispatchEvent(new Event("jyycode:frontend-mounted"))')
  })

  it("turns a repeated frontend stall into an actionable failure", async () => {
    vi.useFakeTimers()
    sessionStorage.setItem("jyycode.frontend-startup-retried", "true")
    document.body.innerHTML = '<main data-startup-shell="true">正在启动 JYYCode…</main>'

    window.eval(watchdogSource)
    await vi.advanceTimersByTimeAsync(15_000)

    const shell = document.querySelector<HTMLElement>('[data-startup-shell="true"]')
    expect(shell).toHaveAttribute("data-failed", "true")
    expect(shell).toHaveTextContent("界面加载失败")
    expect(shell?.querySelector("button")).toHaveTextContent("重新加载")
    expect(shell?.querySelector("button")).toHaveFocus()
  })

  it("keeps one mounted workspace route without a route-wide loading boundary", () => {
    expect(routesSource).toContain('import("./layout/project-workspace")')
    expect(routesSource).toContain('path="/workspace"')
    expect(routesSource).toContain('path="/session/:sessionID"')
    expect(routesSource).not.toContain("Suspense")
  })
})
