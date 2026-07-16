import { describe, expect, it } from "vitest"
import { displayDefaultPermission } from "./default-permission"

describe("displayDefaultPermission", () => {
  it("keeps fine-grained permissions visibly read-only", () => {
    expect(displayDefaultPermission({ mode: "custom" })).toEqual({ label: "自定义配置", editable: false })
  })

  it("labels the three simple policies", () => {
    expect(displayDefaultPermission({ mode: "auto" }).label).toBe("自动")
    expect(displayDefaultPermission({ mode: "request" }).label).toBe("每次询问")
    expect(displayDefaultPermission({ mode: "full" }).label).toBe("完全访问")
  })
})
