export * as WorkflowGenerator from "./generator"

import { Effect } from "effect"
import { Global } from "@jyycode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import type { Workflow } from "./schema"
import { NodeID, WorkflowID, WorkflowVersion } from "./schema"
import { validateWorkflow } from "./validation"
import { WorkflowRuntime } from "./runtime"

export type InterviewQuestion = {
  id: "goal" | "deliverables" | "stages" | "acceptance" | "collaboration" | "permissions" | "installation"
  prompt: string
  required: boolean
}

export type GeneratorStatus = "draft" | "incomplete_draft" | "validating" | "ready" | "invalid" | "installed"

export type WorkflowSpec = {
  status: GeneratorStatus
  identity: { name: string; displayName: string; scope: string }
  applicability: { included: readonly string[]; excluded: readonly string[] }
  outputs: readonly string[]
  unresolved: readonly string[]
  maxConcurrency: number
  maxReplanCycles: number
}

export type ValidationCheck = {
  id: "schema" | "dependencies" | "state_machine" | "acceptance" | "single_simulation" | "multi_simulation"
  valid: boolean
  message: string
}

export type DryRun = {
  mode: "single" | "multi"
  valid: boolean
  steps: readonly string[]
  errors: readonly string[]
}

export type GeneratedFile = { path: string; content: string; kind: "workflow" | "schema" | "prompt" | "test" | "fixture" | "readme" | "report" }

export type GeneratorPreview = {
  status: GeneratorStatus
  workflow: Workflow
  spec: WorkflowSpec
  interview: readonly InterviewQuestion[]
  validation: readonly ValidationCheck[]
  dryRuns: readonly DryRun[]
  files: readonly GeneratedFile[]
  risks: readonly string[]
}

const safeID = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "generated-workflow"

const yamlString = (value: string) => JSON.stringify(value)

export function interview(request: string): readonly InterviewQuestion[] {
  const web = /site|web|网页|网站/i.test(request)
  return [
    { id: "goal", prompt: `Confirm the objective: ${request}`, required: true },
    { id: "deliverables", prompt: web ? "Which pages, assets, test evidence, and preview are required?" : "Which source files, reports, and acceptance evidence are required?", required: true },
    { id: "stages", prompt: "Which execution stages must remain visible and independently reviewable?", required: true },
    { id: "acceptance", prompt: "What deterministic checks or reviewer gates prove the result is acceptable?", required: true },
    { id: "collaboration", prompt: "Which work can safely be delegated to isolated agents, and what must stay with the main agent?", required: false },
    { id: "permissions", prompt: "Does this workflow require special tools, credentials, native handlers, or filesystem scope?", required: false },
    { id: "installation", prompt: "Should the workflow be installed globally or only for this project?", required: true },
  ]
}

export function specification(input: { request: string; id?: string; displayName?: string }): WorkflowSpec {
  const id = input.id ?? safeID(input.request)
  const web = /site|web|网页|网站/i.test(input.request)
  const outputs = web
    ? ["source_code", "build_output", "test_report", "preview", "delivery_notes"]
    : ["source_code", "validation_report", "delivery_notes"]
  return {
    status: "ready",
    identity: { name: id, displayName: input.displayName ?? input.request.slice(0, 80), scope: input.request },
    applicability: {
      included: [input.request],
      excluded: ["Tasks outside the confirmed objective"],
    },
    outputs,
    unresolved: [],
    maxConcurrency: 3,
    maxReplanCycles: 2,
  }
}

export function generate(input: { request: string; id?: string; displayName?: string }): Workflow {
  const spec = specification(input)
  const id = WorkflowID.make(spec.identity.name)
  const acceptance = (title: string) => ({ id: safeID(title), title, required: true })
  return {
    id,
    version: WorkflowVersion.make("1.0.0"),
    displayName: spec.identity.displayName,
    supports: { single: true, multi: true },
    stages: [
      {
        id: NodeID.make("discovery"),
        title: "Discovery",
        dependsOn: [],
        steps: [
          {
            id: NodeID.make("requirements"),
            title: "Requirements and constraints",
            dependsOn: [],
            tasks: [
              {
                id: NodeID.make("requirements"),
                title: "Clarify requirements and acceptance evidence",
                dependsOn: [],
                acceptance: [acceptance("Requirements and acceptance criteria are explicit")],
              },
            ],
          },
        ],
      },
      {
        id: NodeID.make("implementation"),
        title: "Implementation",
        dependsOn: [NodeID.make("discovery")],
        steps: [
          {
            id: NodeID.make("build"),
            title: "Build and integrate",
            dependsOn: [],
            tasks: [
              {
                id: NodeID.make("implementation"),
                title: "Implement the requested work",
                dependsOn: [],
                acceptance: [acceptance("Requested implementation is complete")],
              },
            ],
          },
        ],
      },
      {
        id: NodeID.make("validation"),
        title: "Validation and delivery",
        dependsOn: [NodeID.make("implementation")],
        steps: [
          {
            id: NodeID.make("verify"),
            title: "Verify deliverables",
            dependsOn: [],
            tasks: [
              {
                id: NodeID.make("validation"),
                title: "Run acceptance checks and prepare delivery notes",
                dependsOn: [],
                acceptance: [acceptance("Validation evidence and delivery notes are attached")],
              },
            ],
          },
        ],
      },
    ],
  }
}

function taskCount(workflow: Workflow) {
  return workflow.stages.flatMap((stage) => stage.steps.flatMap((step) => step.tasks)).length
}

export function dryRun(workflow: Workflow): readonly DryRun[] {
  try {
    validateWorkflow(workflow)
  } catch (error) {
    return ["single", "multi"].map((mode) => ({ mode: mode as "single" | "multi", valid: false, steps: [], errors: [String(error)] }))
  }
  const count = taskCount(workflow)
  const noTasks = count === 0 ? ["Workflow has no executable tasks"] : []
  return [
    {
      mode: "single",
      valid: workflow.supports.single && noTasks.length === 0,
      steps: ["Main agent executes dependency-ordered tasks", "Reviewer validates each submitted deliverable", "Main agent integrates accepted results"],
      errors: workflow.supports.single ? noTasks : ["single mode is not supported"],
    },
    {
      mode: "multi",
      valid: workflow.supports.multi && noTasks.length === 0,
      steps: ["Main agent creates isolated assignments", "Child agents submit artifacts and proposals", "Reviewer validates and main agent integrates accepted results"],
      errors: workflow.supports.multi ? noTasks : ["multi mode is not supported"],
    },
  ]
}

export function validate(input: { workflow: Workflow; spec?: WorkflowSpec }): readonly ValidationCheck[] {
  const schema = (() => {
    try { validateWorkflow(input.workflow); return undefined } catch (error) { return String(error) }
  })()
  const tasks = input.workflow.stages.flatMap((stage) => stage.steps.flatMap((step) => step.tasks))
  const dryRuns = dryRun(input.workflow)
  return [
    { id: "schema", valid: !schema, message: schema ?? "Workflow declaration satisfies the schema." },
    { id: "dependencies", valid: !schema, message: schema ? "Dependency validation did not run." : "Dependencies are known and acyclic." },
    { id: "state_machine", valid: tasks.length > 0, message: tasks.length ? "Every generated task can enter the Runtime state machine." : "At least one task is required." },
    { id: "acceptance", valid: tasks.every((task) => task.acceptance.some((rule) => rule.required)), message: "Every generated task has a required acceptance rule." },
    { id: "single_simulation", valid: dryRuns[0]!.valid, message: dryRuns[0]!.valid ? "Single-agent simulation passes." : dryRuns[0]!.errors.join("; ") },
    { id: "multi_simulation", valid: dryRuns[1]!.valid, message: dryRuns[1]!.valid ? "Multi-agent simulation passes." : dryRuns[1]!.errors.join("; ") },
  ]
}

export function repair(workflow: Workflow): { workflow: Workflow; repaired: readonly string[] } {
  const repaired: string[] = []
  const stages = workflow.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => ({
      ...step,
      tasks: step.tasks.map((task) => {
        if (task.acceptance.length) return task
        repaired.push(`Added acceptance rule for ${task.id}`)
        return { ...task, acceptance: [{ id: `${task.id}-accepted`, title: `${task.title} is validated`, required: true }] }
      }),
    })),
  }))
  return { workflow: { ...workflow, stages }, repaired }
}

export function workflowYaml(workflow: Workflow) {
  const lines = [
    `id: ${workflow.id}`,
    `version: ${workflow.version}`,
    `display_name: ${yamlString(workflow.displayName)}`,
    "supports:",
    `  single_agent: ${workflow.supports.single}`,
    `  multi_agent: ${workflow.supports.multi}`,
    "stages:",
  ]
  for (const stage of workflow.stages) {
    lines.push(`  - id: ${stage.id}`, `    title: ${yamlString(stage.title)}`, `    depends_on: [${stage.dependsOn.join(", ")}]`, "    steps:")
    for (const step of stage.steps) {
      lines.push(`      - id: ${step.id}`, `        title: ${yamlString(step.title)}`, "        tasks:")
      for (const task of step.tasks) {
        lines.push(`          - id: ${task.id}`, `            title: ${yamlString(task.title)}`, `            depends_on: [${task.dependsOn.join(", ")}]`)
      }
    }
  }
  return lines.join("\n")
}

export function bundle(input: { workflow: Workflow; spec: WorkflowSpec; validation: readonly ValidationCheck[] }): readonly GeneratedFile[] {
  const root = `.jyycode/workflows/${input.workflow.id}`
  const report = JSON.stringify({ status: input.validation.every((check) => check.valid) ? "ready" : "invalid", checks: input.validation }, null, 2)
  return [
    { path: `${root}/workflow.yaml`, content: workflowYaml(input.workflow), kind: "workflow" },
    { path: `${root}/workflow.schema.json`, content: JSON.stringify({ title: "JYYCode Workflow", type: "object", required: ["id", "version", "stages"] }, null, 2), kind: "schema" },
    { path: `${root}/prompts/main-agent.md`, content: `# ${input.spec.identity.displayName}\n\n${input.spec.identity.scope}`, kind: "prompt" },
    { path: `${root}/tests/workflow.test.ts`, content: `// Generated validation fixture for ${input.workflow.id}\n`, kind: "test" },
    { path: `${root}/fixtures/request.md`, content: input.spec.identity.scope, kind: "fixture" },
    { path: `${root}/README.md`, content: `# ${input.spec.identity.displayName}\n\nOutputs: ${input.spec.outputs.join(", ")}`, kind: "readme" },
    { path: `${root}/validation-report.json`, content: report, kind: "report" },
  ]
}

export function preview(input: { request: string; id?: string; displayName?: string }): GeneratorPreview {
  const spec = specification(input)
  const generated = generate(input)
  const repaired = repair(generated)
  const validation = validate({ workflow: repaired.workflow, spec })
  const dryRuns = dryRun(repaired.workflow)
  const valid = validation.every((check) => check.valid) && dryRuns.every((run) => run.valid)
  return {
    status: valid && spec.unresolved.length === 0 ? "ready" : spec.unresolved.length ? "incomplete_draft" : "invalid",
    workflow: repaired.workflow,
    spec,
    interview: interview(input.request),
    validation,
    dryRuns,
    files: bundle({ workflow: repaired.workflow, spec, validation }),
    risks: ["Native handlers and elevated permissions require separate explicit review before installation."],
  }
}

async function writeBundle(input: { root: string; files: readonly GeneratedFile[] }) {
  const root = path.resolve(input.root)
  for (const file of input.files) {
    const target = path.resolve(root, file.path)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Generated file escapes installation root: ${file.path}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, "utf8")
  }
}

export const install = Effect.fn("WorkflowGenerator.install")(function* (input: {
  workflow: Workflow
  confirmed: boolean
  scope?: "global" | "project"
  directory?: string
}) {
  if (!input.confirmed) return yield* Effect.fail(new Error("Workflow installation requires explicit user confirmation"))
  const repaired = repair(input.workflow)
  const validation = validate({ workflow: repaired.workflow })
  if (validation.some((check) => !check.valid)) return yield* Effect.fail(new Error(`Workflow validation failed: ${validation.filter((check) => !check.valid).map((check) => check.message).join("; ")}`))
  const spec = specification({ request: repaired.workflow.displayName, id: repaired.workflow.id, displayName: repaired.workflow.displayName })
  const files = bundle({ workflow: repaired.workflow, spec, validation })
  const root = input.scope === "project" ? input.directory : Global.Path.config
  if (!root) return yield* Effect.fail(new Error("Project workflow installation requires a workspace directory"))
  yield* Effect.tryPromise({ try: () => writeBundle({ root, files }), catch: (error) => new Error(`Unable to write workflow package: ${String(error)}`) })
  yield* WorkflowRuntime.registerWorkflow({ workflow: repaired.workflow, scope: input.scope ?? "global", source: "generator", installed: true })
  return repaired.workflow
})
