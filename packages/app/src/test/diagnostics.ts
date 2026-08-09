import { expect, vi } from "vitest"

type ConsoleArgs = unknown[]

function formatArgs(args: ConsoleArgs) {
  return args
    .map((value) => {
      if (value instanceof Error) return value.stack ?? value.message
      if (typeof value === "string") return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(" ")
}

function formatCapture(errors: ConsoleArgs[], warnings: ConsoleArgs[], rejections: unknown[]) {
  return [
    ...errors.map((args) => `console.error: ${formatArgs(args)}`),
    ...warnings.map((args) => `console.warn: ${formatArgs(args)}`),
    ...rejections.map((reason) => `unhandledrejection: ${formatArgs([reason])}`),
  ].join("\n")
}

export async function withConsoleErrorCapture<T>(callback: () => T | Promise<T>) {
  const errors: ConsoleArgs[] = []
  const warnings: ConsoleArgs[] = []
  const rejections: unknown[] = []
  const reportError = console.error.bind(console)
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args))
  const warningSpy = vi.spyOn(console, "warn").mockImplementation((...args) => warnings.push(args))
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason)
  }
  window.addEventListener("unhandledrejection", onUnhandledRejection)

  try {
    const result = await callback()
    const diagnostics = formatCapture(errors, warnings, rejections)
    expect(diagnostics, diagnostics || "no diagnostics").toBe("")
    return result
  } catch (error) {
    const diagnostics = formatCapture(errors, warnings, rejections)
    if (diagnostics) reportError(diagnostics)
    throw error
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandledRejection)
    errorSpy.mockRestore()
    warningSpy.mockRestore()
  }
}
