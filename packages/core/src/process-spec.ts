import type { PlatformError } from "effect/PlatformError"
import type * as Stream from "effect/Stream"
import type * as Duration from "effect/Duration"

export type ProcessEnvironment = {
  readonly mode: "scrubbed" | "inherit-allowlist"
  readonly values?: Readonly<Record<string, string>>
}

export type ProcessOutput = "capture" | "stream" | "inherit"

export type ProcessSpec = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: ProcessEnvironment
  readonly shell?: boolean | string
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
  readonly output: ProcessOutput
  readonly timeout?: Duration.Input
}
