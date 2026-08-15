import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

export type RuntimeBudgetProfile = "pr" | "nightly"

export function runtimeBudgetProfile(): RuntimeBudgetProfile {
  return process.env.RUNTIME_STRESS_PROFILE === "nightly" ? "nightly" : "pr"
}

export function runtimeBudgetDirectory() {
  return process.env.RUNTIME_BUDGET_DIR ?? path.join(process.cwd(), ".artifacts", "runtime-budget")
}

export async function writeRuntimeMetric(name: string, metric: Record<string, unknown>) {
  const directory = runtimeBudgetDirectory()
  await mkdir(directory, { recursive: true })
  const output = {
    version: 1,
    profile: runtimeBudgetProfile(),
    name,
    ...metric,
  }
  await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8")
  return output
}

export function stressCount(name: string, prDefault: number, nightlyDefault: number) {
  const override = process.env[`RUNTIME_STRESS_${name.toUpperCase()}`]
  if (override !== undefined) {
    const value = Number(override)
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid RUNTIME_STRESS_${name.toUpperCase()}: ${override}`)
    return value
  }
  return runtimeBudgetProfile() === "nightly" ? nightlyDefault : prDefault
}

export function peakRss(before: number, after: number) {
  return Math.max(before, after, process.memoryUsage().rss)
}
