import fs from "node:fs"
import path from "node:path"
import { isStepComplete, PlanProtocolError, type PlanFile, type PlanTask, type TaskInput } from "./schema"
import { resolveInside } from "./path-guard"

function invalid(message: string): never {
  throw new PlanProtocolError({
    code: "TASK_DEPENDENCY_INVALID",
    message,
    hint: "同一 Step 的任务必须独立并行。将消费其他任务产物的任务移到后续 Step；独立任务保留在同一 Step，不要逐个串行派发。",
  })
}

export function parseTaskInputs(value: unknown): TaskInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid("inputs 必须是数组；没有文件输入时使用 []")
  return value.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      invalid("inputs[] 必须包含相对 path 和可选 from_task")
    const item = input as Record<string, unknown>
    if (Object.keys(item).some((key) => key !== "path" && key !== "from_task"))
      invalid("inputs[] 仅允许 path 和 from_task")
    if (typeof item.path !== "string" || !item.path.trim()) invalid("inputs[].path 必须是非空工作区相对路径")
    const relative = item.path.trim().replaceAll("\\", "/")
    if (
      /^[A-Za-z]:/.test(relative) ||
      path.posix.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) ||
      relative.split("/").includes("..")
    )
      invalid(`输入 ${relative} 必须位于当前工作区内，不能指向其他子 Agent 的工作区`)
    if (
      item.from_task !== undefined &&
      (typeof item.from_task !== "string" || !/^s[1-9]\d*_t[1-9]\d*$/.test(item.from_task))
    )
      invalid("inputs[].from_task 必须是已有任务 ID")
    return { path: relative, ...(typeof item.from_task === "string" ? { from_task: item.from_task } : {}) }
  })
}

export function validateTaskDependencies(plan: PlanFile) {
  const producers = new Map(
    plan.steps.flatMap((step, index) => step.tasks.map((task) => [task.id, { step, index }] as const)),
  )
  for (const [index, step] of plan.steps.entries()) {
    for (const task of step.tasks) {
      for (const input of parseTaskInputs(task.inputs)) {
        if (!input.from_task) continue
        const producer = producers.get(input.from_task)
        if (!producer) invalid(`${task.id} 引用了不存在的产物任务 ${input.from_task}`)
        if (producer.index >= index)
          invalid(`${task.id} 不能依赖${producer.index === index ? "同一" : "后续"} Step 的 ${input.from_task} 产物`)
      }
    }
  }
}

/** Resolve only files published before this Step and present in its frozen baseline. */
export function validateTaskInputFiles(input: {
  plan: PlanFile
  task: PlanTask
  workspaceRoot: string
  baselineRoot: string
}) {
  for (const file of input.task.inputs ?? []) {
    if (file.from_task) {
      const step = input.plan.steps.find((candidate) => candidate.tasks.some((task) => task.id === file.from_task))!
      const producer = step.tasks.find((task) => task.id === file.from_task)!
      if (step.status !== "done" || !isStepComplete(step, input.workspaceRoot) || producer.status !== "approved")
        invalid(`${input.task.id} 的输入 ${file.path} 尚未由前序 Step 完成审核和合并`)
      const rootPath = resolveInside(input.workspaceRoot, file.path, "input.path")
      const produced =
        (producer.report?.artifacts ?? []).some((artifact) => {
          const sourceRoot = producer.dispatch?.workspace?.directory ?? input.workspaceRoot
          const relative = path.relative(sourceRoot, path.resolve(sourceRoot, artifact))
          return resolveInside(input.workspaceRoot, relative, "published artifact") === rootPath
        }) ||
        (step.candidate_selection?.selected_task_id === producer.id &&
          resolveInside(input.workspaceRoot, step.candidate_selection.synthesis_artifact, "synthesis artifact") ===
            rootPath)
      if (!produced) invalid(`${file.path} 不是 ${producer.id} 已验收发布的产物`)
    }
    const filename = resolveInside(input.baselineRoot, file.path, "input.path")
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      throw new PlanProtocolError({
        code: "TASK_INPUT_MISSING",
        message: `${input.task.id} 的输入 ${file.path} 不在本 Step 的固定基线中`,
        hint: "先在前序 Step 完成并合并该输入，再在后续 Step 使用。不能等待同 Step 子 Agent 的产物，也不能读取其工作区。",
      })
    }
  }
}
