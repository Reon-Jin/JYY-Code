import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const indexHTML = readFileSync("index.html", "utf8")
const entrySource = readFileSync("src/index.tsx", "utf8")
const routesSource = readFileSync("src/routes.tsx", "utf8")

describe("desktop startup shell", () => {
  it("paints a branded loading state before JavaScript is ready", () => {
    expect(indexHTML).toContain('data-startup-shell="true"')
    expect(indexHTML).toContain("正在启动 JYYCode")
    expect(indexHTML).toMatch(/html,\s*body,\s*#root\s*\{[^}]*background:\s*#181818;/s)
    expect(entrySource).toContain("root.replaceChildren()")
  })

  it("loads the heavy project workspace after the application shell", () => {
    expect(routesSource).toMatch(/lazy\(\(\) => import\("\.\/layout\/project-workspace"\)\)/)
  })
})
