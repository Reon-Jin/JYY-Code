import { For, Show } from 'solid-js'
import { ProgressBar } from '../ui/ProgressBar'
import type { TaskPlan, TaskStep } from '../../types/models'

interface Props {
  plan: TaskPlan | null
}

export function TaskPlanningView(props: Props) {
  return (
    <Show
      when={props.plan}
      fallback={
        <div class="panel-empty">
          <h3>Progress</h3>
          <p>Task steps will appear here while the agent works.</p>
        </div>
      }
    >
      <section class="panel-section">
        <div class="panel-heading">
          <h3>Progress</h3>
          <span>
            {props.plan!.currentStepIndex + 1}/{props.plan!.totalSteps}
          </span>
        </div>

        <ProgressBar value={props.plan!.currentStepIndex + 1} max={props.plan!.totalSteps} showLabel size="md" />

        <div class="task-list">
          <For each={props.plan!.steps}>
            {(step, index) => <TaskStepItem step={step} isActive={index() === props.plan!.currentStepIndex} />}
          </For>
        </div>
      </section>
    </Show>
  )
}

function TaskStepItem(props: { step: TaskStep; isActive: boolean }) {
  const marker = () => {
    if (props.step.status === 'completed') return 'done'
    if (props.step.status === 'running') return 'run'
    if (props.step.status === 'failed') return 'fail'
    return 'todo'
  }

  return (
    <div class="task-step" data-active={props.isActive} data-status={props.step.status}>
      <span class="task-marker" data-marker={marker()} />
      <div class="task-step-body">
        <strong>{props.step.title}</strong>
        <Show when={props.step.detail}>
          <p>{props.step.detail}</p>
        </Show>
      </div>
      <Show when={props.step.elapsed !== undefined}>
        <span class="task-time">{props.step.elapsed!.toFixed(1)}s</span>
      </Show>
    </div>
  )
}
