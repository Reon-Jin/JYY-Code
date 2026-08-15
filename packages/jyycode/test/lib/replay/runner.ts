import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { decodeReplayFixture, type ReplayFixture } from "./schema"
import { assertReplayValueFree, normalizeFixture, stableJson, type ReplayNormalizationOptions } from "./normalize"

export type ReplayObservation = Pick<ReplayFixture, "expected" | "terminalStatus">
export type ReplayExecutor = (fixture: ReplayFixture) => Promise<ReplayObservation> | ReplayObservation

export type ReplayRunOptions = ReplayNormalizationOptions & {
  execute?: ReplayExecutor
}

export async function readReplayFixture(path: string) {
  const fixture = decodeReplayFixture(JSON.parse(await readFile(path, "utf8")))
  assertReplayValueFree(fixture)
  return fixture
}

function comparable(fixture: ReplayFixture, observation: ReplayObservation, options: ReplayNormalizationOptions) {
  return normalizeFixture({ expected: observation.expected, terminalStatus: observation.terminalStatus }, options)
}

export async function assertFixture(path: string, options: ReplayRunOptions = {}) {
  const fixture = await readReplayFixture(path)
  const expected = comparable(fixture, { expected: fixture.expected, terminalStatus: fixture.terminalStatus }, options)
  if (!options.execute) return { fixture, normalized: expected }

  const actual = await options.execute(fixture)
  assertReplayValueFree(actual)
  const observed = comparable(fixture, actual, options)
  const expectedJson = stableJson(expected)
  const observedJson = stableJson(observed)
  if (expectedJson !== observedJson) {
    throw new Error(`Replay fixture mismatch: ${path}\nExpected:\n${expectedJson}\nObserved:\n${observedJson}`)
  }
  return { fixture, normalized: expected }
}

export async function updateFixture(path: string, execute: ReplayExecutor, options: ReplayRunOptions = {}) {
  if (process.env.UPDATE_REPLAY !== "1") throw new Error("Refusing to update replay fixture without UPDATE_REPLAY=1")
  if (process.env.CI === "true" || process.env.CI === "1") throw new Error("Replay fixture updates are disabled in CI")

  const fixture = await readReplayFixture(path)
  const actual = await execute(fixture)
  assertReplayValueFree(actual)
  const updated = normalizeFixture({ ...fixture, expected: actual.expected, terminalStatus: actual.terminalStatus }, options)
  await Bun.write(resolve(dirname(path), path.split(/[\\/]/).at(-1)!), stableJson(updated))
  return updated
}
