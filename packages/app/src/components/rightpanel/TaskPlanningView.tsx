import { For, Show } from 'solid-js'
import { ProgressBar } from '../ui/ProgressBar'
import type { TaskPlan, TaskStep } from '../../types/models'

interface Props {
  plan: TaskPlan | null
}

export function TaskPlanningView(props: Props) {
  return (
    <>
      <Show when={props.plan} fallback={
        <div style={{
          'text-align': 'center',
          padding: '32px 0',
          color: 'var(--color-text-tertiary)',
        }}>
          <p style={{ 'font-size': '28px', 'margin-bottom': '12px' }}>📋</p>
          <p class="text-caption">暂无任务规划</p>
          <p class="text-micro" style={{ 'margin-top': '8px', color: 'var(--color-text-tertiary)' }}>
            当 Agent 开始执行复杂任务时，规划将在此显示
          </p>
        </div>
      }>
        <div>
          <h4 class="text-caption-bold" style={{ 'margin-bottom': '16px', color: 'var(--color-text-secondary)' }}>
            任务规划
          </h4>

          {/* Progress */}
          <div style={{ 'margin-bottom': '20px' }}>
            <ProgressBar
              value={props.plan!.currentStepIndex + 1}
              max={props.plan!.totalSteps}
              showLabel
              size="md"
            />
            {props.plan!.estimatedTime && (
              <p class="text-micro" style={{
                'margin-top': '4px',
                color: 'var(--color-text-tertiary)',
              }}>
                预估剩余: ~{props.plan!.estimatedTime}s
              </p>
            )}
          </div>

          {/* Steps */}
          <div style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: 'var(--space-8)',
          }}>
            <For each={props.plan!.steps}>
              {(step, index) => <TaskStepItem step={step} isActive={index() === props.plan!.currentStepIndex} />}
            </For>
          </div>
        </div>
      </Show>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </>
  )
}

// Single task step item
function TaskStepItem(props: { step: TaskStep; isActive: boolean }) {
  const { step, isActive } = props

  const statusIcon = () => {
    switch (step.status) {
      case 'completed': return '✓'
      case 'running': return '●'
      case 'failed': return '✗'
      default: return '○'
    }
  }

  const statusColor = () => {
    switch (step.status) {
      case 'completed': return '#34c759'
      case 'running': return 'var(--color-blue-apple)'
      case 'failed': return '#ff3b30'
      default: return 'var(--color-text-tertiary)'
    }
  }

  const isDimmed = () => step.status === 'completed'

  return (
    <div style={{
      display: 'flex',
      'align-items': 'flex-start',
      gap: 'var(--space-10)',
      padding: 'var(--space-8) var(--space-10)',
      'border-radius': 'var(--radius-standard)',
      background: isActive ? 'rgba(0,113,227,0.06)' : 'transparent',
      transition: 'background 0.2s',
    }}>
      {/* Status icon */}
      <span style={{
        'font-size': '14px',
        color: statusColor(),
        'margin-top': '2px',
        'flex-shrink': '0',
        width: '20px',
        'text-align': 'center',
        ...(step.status === 'running' ? { animation: 'pulse 1.5s infinite' } : {}),
      }}>
        {statusIcon()}
      </span>

      {/* Content */}
      <div style={{ flex: '1', 'min-width': '0' }}>
        <p class="text-caption" style={{
          color: isDimmed() ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
          'font-weight': isActive ? '600' : '400',
        }}>
          {step.title}
        </p>
        {step.detail && (
          <p class="text-micro" style={{
            color: 'var(--color-text-tertiary)',
            'margin-top': '2px',
          }}>
            {step.detail}
          </p>
        )}
      </div>

      {/* Elapsed time */}
      {step.elapsed !== undefined && (
        <span class="text-micro" style={{
          color: 'var(--color-text-tertiary)',
          'flex-shrink': '0',
        }}>
          {step.elapsed.toFixed(1)}s
        </span>
      )}
    </div>
  )
}
