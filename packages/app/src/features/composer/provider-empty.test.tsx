import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderEmpty } from "./provider-empty"

afterEach(() => cleanup())

describe("ProviderEmpty", () => {
  it("keeps Connect available when no model is configured", () => {
    render(() => (
      <ProviderEmpty
        client={{} as never}
        configPath="C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc"
        directory="C:\\work\\demo"
        onProviderConnected={vi.fn()}
      />
    ))

    expect(screen.getByRole("button", { name: "Connect" })).toBeVisible()
  })
})
