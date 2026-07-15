import { render, screen } from "@solidjs/testing-library"
import { Plus } from "lucide-solid"
import { describe, expect, it } from "vitest"
import { Button, IconButton } from "./button"

describe("Button", () => {
  it("gives icon-only buttons an accessible name", () => {
    render(() => (
      <IconButton label="新建 Session">
        <Plus aria-hidden="true" />
      </IconButton>
    ))

    expect(screen.getByRole("button", { name: "新建 Session" })).toBeVisible()
  })

  it("exposes a non-interactive loading state", () => {
    render(() => <Button loading>创建项目</Button>)

    const button = screen.getByRole("button", { name: "处理中" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
  })
})
