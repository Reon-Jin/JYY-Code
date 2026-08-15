import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

type Metric = {
  version: number
  profile: string
  name: string
  [key: string]: unknown
}

type BudgetProfile = {
  session_replay: Array<{ events: number; duration_ms: number; peak_rss_bytes: number }>
  process_cancel: { processes: number; duration_ms: number }
  plan_recovery: { children: number; duration_ms: number }
}

type Baseline = {
  version: number
  profiles: Record<string, BudgetProfile>
}

const rootDir = path.resolve(import.meta.dir, "..")
const baselinePath = path.join(rootDir, "packages", "jyycode", "test", "stress", "runtime-budget.baseline.json")
const metricsDir =
  process.env.RUNTIME_BUDGET_DIR ?? path.join(rootDir, "packages", "jyycode", ".artifacts", "runtime-budget")
const profile = process.env.RUNTIME_STRESS_PROFILE === "nightly" ? "nightly" : "pr"
const multiplier = Number(process.env.RUNTIME_BUDGET_MULTIPLIER ?? 2)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function readJson<T>(pathname: string) {
  return JSON.parse(await readFile(pathname, "utf8")) as T
}

async function readMetrics() {
  let files: string[]
  try {
    files = (await readdir(metricsDir)).filter((file) => file.endsWith(".json"))
  } catch {
    throw new Error(`runtime budget metrics are missing: ${metricsDir}`)
  }
  const metrics = await Promise.all(files.map((file) => readJson<Metric>(path.join(metricsDir, file))))
  const selected = metrics.filter((metric) => metric.profile === profile)
  if (selected.length === 0) throw new Error(`runtime budget metrics for profile ${profile} are missing: ${metricsDir}`)
  return selected
}

function measuredProfile(metrics: Metric[]): BudgetProfile {
  const session = metrics.find((metric) => metric.name === "session-replay")
  const process = metrics.find((metric) => metric.name === "process-cancel")
  const plan = metrics.find((metric) => metric.name === "plan-recovery")
  if (!isRecord(session) || !Array.isArray(session.measurements)) throw new Error("session-replay metrics are missing")
  if (!isRecord(process) || typeof process.processes !== "number" || typeof process.duration_ms !== "number")
    throw new Error("process-cancel metrics are missing")
  if (!isRecord(plan) || typeof plan.children !== "number" || typeof plan.duration_ms !== "number")
    throw new Error("plan-recovery metrics are missing")

  return {
    session_replay: session.measurements.map((measurement) => {
      if (!isRecord(measurement)) throw new Error("invalid session-replay measurement")
      if (
        typeof measurement.events !== "number" ||
        typeof measurement.duration_ms !== "number" ||
        typeof measurement.peak_rss_bytes !== "number"
      )
        throw new Error("invalid session-replay measurement")
      return {
        events: measurement.events,
        duration_ms: measurement.duration_ms,
        peak_rss_bytes: measurement.peak_rss_bytes,
      }
    }),
    process_cancel: { processes: process.processes, duration_ms: process.duration_ms },
    plan_recovery: { children: plan.children, duration_ms: plan.duration_ms },
  }
}

function checkAtMost(failures: string[], label: string, actual: number, baseline: number) {
  const noiseFloor = label.endsWith("duration_ms") ? 250 : 1
  const limit = Math.max(noiseFloor, baseline * multiplier)
  if (actual > limit)
    failures.push(`${label}=${actual} exceeds ${limit} (baseline ${baseline}, multiplier ${multiplier})`)
}

async function main() {
  const metrics = await readMetrics()
  const measured = measuredProfile(metrics)
  const baseline = await readJson<Baseline>(baselinePath)

  if (process.env.UPDATE_BUDGET === "1") {
    if (process.env.CI === "true" || process.env.CI === "1") throw new Error("Refusing to update runtime budgets in CI")
    baseline.profiles[profile] = measured
    await mkdir(path.dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8")
    console.log(`Updated runtime budget baseline for ${profile}: ${baselinePath}`)
    return
  }

  const expected = baseline.profiles[profile]
  if (!expected) throw new Error(`runtime budget baseline for profile ${profile} is missing`)
  const failures: string[] = []
  for (const measurement of measured.session_replay) {
    const reference = expected.session_replay.find((item) => item.events === measurement.events)
    if (!reference) {
      failures.push(`session-replay event count ${measurement.events} has no baseline`)
      continue
    }
    checkAtMost(
      failures,
      `session-replay ${measurement.events} duration_ms`,
      measurement.duration_ms,
      reference.duration_ms,
    )
    checkAtMost(
      failures,
      `session-replay ${measurement.events} peak_rss_bytes`,
      measurement.peak_rss_bytes,
      reference.peak_rss_bytes,
    )
  }
  const processReference = expected.process_cancel
  if (measured.process_cancel.processes !== processReference.processes)
    failures.push(
      `process-cancel process count ${measured.process_cancel.processes} does not match baseline ${processReference.processes}`,
    )
  checkAtMost(failures, "process-cancel duration_ms", measured.process_cancel.duration_ms, processReference.duration_ms)
  const planReference = expected.plan_recovery
  if (measured.plan_recovery.children !== planReference.children)
    failures.push(
      `plan-recovery child count ${measured.plan_recovery.children} does not match baseline ${planReference.children}`,
    )
  checkAtMost(failures, "plan-recovery duration_ms", measured.plan_recovery.duration_ms, planReference.duration_ms)

  const processMetric = metrics.find((metric) => metric.name === "process-cancel")!
  if (processMetric.remaining_pids !== 0)
    failures.push(`process-cancel remaining_pids=${String(processMetric.remaining_pids)}`)
  const planMetric = metrics.find((metric) => metric.name === "plan-recovery")!
  if (planMetric.remaining_children !== 0)
    failures.push(`plan-recovery remaining_children=${String(planMetric.remaining_children)}`)

  if (failures.length > 0) throw new Error(`Runtime budget regression for ${profile}:\n- ${failures.join("\n- ")}`)
  console.log(`Runtime budgets are within ${multiplier}x baseline for ${profile}.`)
}

await main()
