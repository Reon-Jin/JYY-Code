import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { App } from "./app"

describe("App", () => {
  it("shows a non-blank startup state", () => {
    render(() => <App />)
    expect(screen.getByRole("status")).toHaveTextContent("正在启动 JYYCode")
  })
})
