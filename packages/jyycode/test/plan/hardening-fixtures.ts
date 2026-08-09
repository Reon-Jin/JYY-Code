import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChildController, PlanExecutionContext } from "../../src/plan/protocol"
import { planFilePath, type CreatePlanInput, type PlanFile } from "../../src/plan/schema"

export function createHardeningWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-hardening-"))
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export function createMergeWorkspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-merge-"))
  const parent = path.join(root, "parent")
  const baseline = path.join(root, "baseline")
  const child = path.join(root, "child")
  fs.mkdirSync(parent, { recursive: true })
  fs.mkdirSync(baseline, { recursive: true })
  fs.mkdirSync(child, { recursive: true })
  return {
    root,
    parent,
    baseline,
    child,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export function hardeningContext(
  workspaceRoot: string,
  sessionId = "ses_main",
  mode: "single" | "multi" = "multi",
): PlanExecutionContext {
  return { workspaceRoot, sessionId, mode }
}

export function hardeningPlanInput(outputPath: string): CreatePlanInput {
  return {
    title: "可靠性加固",
    goal: "验证并发和恢复行为",
    steps: [
      {
        title: "回归测试",
        goal: "固定故障行为",
        done_criteria: "回归测试通过",
        tasks: [
          {
            title: "验证报告",
            goal: "提交并审查产物",
            done_criteria: "产物文件存在",
            output_path: outputPath,
          },
        ],
      },
      {
        title: "完成验收",
        goal: "完成可靠性验证",
        done_criteria: "所有回归测试通过",
      },
    ],
  }
}

export function readHardeningPlan(workspaceRoot: string, sessionId = "ses_main") {
  return JSON.parse(fs.readFileSync(planFilePath(workspaceRoot, sessionId), "utf8")) as PlanFile
}

export function createHardeningChildren(options: {
  createFailures?: number
  startFailures?: number
  terminateFailures?: number
} = {}) {
  let createFailures = options.createFailures ?? 0
  let startFailures = options.startFailures ?? 0
  let terminateFailures = options.terminateFailures ?? 0
  const calls = { create: 0, start: 0, terminate: 0 }
  const controller: ChildController = {
    async create(input) {
      calls.create++
      if (createFailures-- > 0) throw new Error("child create failed")
      return input.childSessionId
    },
    async start() {
      calls.start++
      if (startFailures-- > 0) throw new Error("child start failed")
    },
    async terminate() {
      calls.terminate++
      if (terminateFailures-- > 0) throw new Error("child terminate failed")
    },
  }
  return { controller, calls }
}

export function createFakeArtifact(pathname: string, failures = 0) {
  let attempts = 0
  return {
    pathname,
    get attempts() {
      return attempts
    },
    write(content = "artifact") {
      attempts++
      if (attempts <= failures) return false
      fs.mkdirSync(path.dirname(pathname), { recursive: true })
      fs.writeFileSync(pathname, content)
      return true
    },
  }
}
