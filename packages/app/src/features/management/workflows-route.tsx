import type { WorkflowGeneratorPreviewResponse } from "@jyycode-ai/sdk/v2/client"
import { CheckCircle2, FileCode2, ShieldAlert, Sparkles } from "lucide-solid"
import { createSignal, For, Show } from "solid-js"
import { useManagement } from "./management-context"
import "./workflows-route.css"

export default function WorkflowsRoute() {
  const management = useManagement()
  const [request, setRequest] = createSignal("")
  const [scope, setScope] = createSignal<"global" | "project">("global")
  const [preview, setPreview] = createSignal<WorkflowGeneratorPreviewResponse>()
  const [error, setError] = createSignal<string>()
  const [installing, setInstalling] = createSignal(false)
  const [installed, setInstalled] = createSignal(false)

  async function generate() {
    const text = request().trim()
    if (!text) return
    setError(undefined)
    setInstalled(false)
    try {
      const result = await management.client.workflow.generatorPreview(
        { directory: management.directory, request: text },
        { throwOnError: true },
      )
      setPreview(result.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to generate workflow preview")
    }
  }

  async function install() {
    const value = preview()
    if (!value || value.status !== "ready") return
    setInstalling(true)
    setError(undefined)
    try {
      await management.client.workflow.generatorInstall(
        { directory: management.directory, workflow: value.workflow, confirmed: true, scope: scope() },
        { throwOnError: true },
      )
      setInstalled(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to install workflow")
    } finally {
      setInstalling(false)
    }
  }

  return (
    <main class="workflow-management">
      <header>
        <div>
          <p>WORKFLOWS</p>
          <h1>Workflow Builder</h1>
          <span>Generate a reviewed workflow package, inspect its runtime simulations, then install it explicitly.</span>
        </div>
      </header>

      <section class="workflow-management__composer">
        <label for="workflow-request">What should this workflow accomplish?</label>
        <textarea
          id="workflow-request"
          value={request()}
          onInput={(event) => setRequest(event.currentTarget.value)}
          placeholder="Create a website production workflow"
        />
        <div class="workflow-management__composer-actions">
          <button type="button" onClick={() => void generate()} disabled={!request().trim()}>
            <Sparkles aria-hidden="true" /> Generate preview
          </button>
          <label>
            Install scope
            <select value={scope()} onChange={(event) => setScope(event.currentTarget.value as "global" | "project")}>
              <option value="global">Global</option>
              <option value="project">This project</option>
            </select>
          </label>
        </div>
      </section>

      <Show when={error()}>{(message) => <p class="workflow-management__error" role="alert">{message()}</p>}</Show>
      <Show when={installed()}><p class="workflow-management__success" role="status"><CheckCircle2 aria-hidden="true" /> Workflow installed and available to routing.</p></Show>

      <Show when={preview()}>
        {(value) => (
          <section class="workflow-management__preview">
            <header>
              <div>
                <p>PREVIEW · {value().status}</p>
                <h2>{value().workflow.displayName}</h2>
                <small>{value().workflow.id}@{value().workflow.version}</small>
              </div>
              <button type="button" onClick={() => void install()} disabled={installing() || value().status !== "ready"}>
                {installing() ? "Installing…" : "Confirm and install"}
              </button>
            </header>

            <div class="workflow-management__summary">
              <span><strong>{value().workflow.stages.length}</strong> stages</span>
              <span><strong>{value().spec.outputs.length}</strong> deliverables</span>
              <span><strong>{value().spec.maxConcurrency}</strong> max parallel agents</span>
              <span><strong>{value().spec.maxReplanCycles}</strong> replan cycles</span>
            </div>

            <div class="workflow-management__grid">
              <article>
                <h3>Specification</h3>
                <p>{value().spec.identity.scope}</p>
                <small>Outputs</small>
                <ul>{value().spec.outputs.map((output) => <li>{output}</li>)}</ul>
              </article>
              <article>
                <h3>Interview gates</h3>
                <ul>{value().interview.map((item) => <li><span data-required={item.required}>{item.required ? "Required" : "Optional"}</span>{item.prompt}</li>)}</ul>
              </article>
              <article>
                <h3>Runtime validation</h3>
                <For each={value().validation}>
                  {(check) => <div class="workflow-management__run" data-valid={check.valid}><strong>{check.id}</strong><span>{check.message}</span></div>}
                </For>
              </article>
              <article>
                <h3>Dry run</h3>
                <For each={value().dryRuns}>
                  {(run) => <div class="workflow-management__run" data-valid={run.valid}><strong>{run.mode}</strong><span>{run.valid ? run.steps.join(" · ") : run.errors.join(" · ")}</span></div>}
                </For>
              </article>
            </div>

            <section class="workflow-management__stages">
              <h3>Generated stages</h3>
              <For each={value().workflow.stages}>
                {(stage) => <article><strong>{stage.title}</strong><small>{stage.steps.flatMap((step) => step.tasks).map((task) => task.title).join(" · ")}</small></article>}
              </For>
            </section>

            <details class="workflow-management__files">
              <summary><FileCode2 aria-hidden="true" /> Generated package <small>{value().files.length} files</small></summary>
              <For each={value().files}>{(file) => <article><header><strong>{file.path}</strong><small>{file.kind}</small></header><pre>{file.content}</pre></article>}</For>
            </details>

            <Show when={value().risks.length}>
              <section class="workflow-management__risks"><ShieldAlert aria-hidden="true" /><div><strong>Installation review</strong><For each={value().risks}>{(risk) => <p>{risk}</p>}</For></div></section>
            </Show>
          </section>
        )}
      </Show>
    </main>
  )
}
