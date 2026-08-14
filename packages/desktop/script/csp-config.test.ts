import { describe, expect, it } from "bun:test"

const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url)

describe("desktop CSP configuration", () => {
  it("allows runtime styles without disabling script protection", async () => {
    const config = JSON.parse(await Bun.file(configPath).text()) as {
      app: {
        security: {
          csp: string
          dangerousDisableAssetCspModification?: boolean | string[]
        }
      }
    }
    const security = config.app.security
    const directives = Object.fromEntries(
      security.csp.split(";").map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/)
        return [name, sources]
      }),
    )

    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"])
    expect(directives["connect-src"]).toEqual(["'self'", "http://127.0.0.1:*"])
    expect(security.csp).not.toContain("google")
    expect(directives["style-src"]).toContain("'unsafe-inline'")
    expect(directives["script-src"]).not.toContain("'unsafe-inline'")
  })
})
