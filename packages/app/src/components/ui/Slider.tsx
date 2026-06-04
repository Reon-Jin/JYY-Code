import { type JSX, splitProps } from 'solid-js'

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  labels?: string[]          // label for each stop point
  disabled?: boolean
  class?: string
}

export function Slider(props: SliderProps) {
  const [local, rest] = splitProps(props, ['value', 'min', 'max', 'step', 'onChange', 'labels', 'disabled', 'class'])
  const min = local.min ?? 0
  const max = local.max ?? 100
  const step = local.step ?? 1

  const trackStyle: JSX.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '4px',
    'border-radius': '2px',
    background: 'rgba(0,0,0,0.1)',
    cursor: local.disabled ? 'not-allowed' : 'pointer',
    opacity: local.disabled ? 0.5 : 1,
  }

  const fillStyle: JSX.CSSProperties = {
    position: 'absolute',
    height: '100%',
    'border-radius': '2px',
    background: 'var(--color-blue-apple)',
    width: `${((local.value - min) / (max - min)) * 100}%`,
    transition: 'width 0.15s ease',
  }

  const thumbStyle: JSX.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: `${((local.value - min) / (max - min)) * 100}%`,
    transform: 'translate(-50%, -50%)',
    width: '20px',
    height: '20px',
    'border-radius': '50%',
    background: 'var(--color-white)',
    'box-shadow': '0 1px 4px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)',
    cursor: local.disabled ? 'not-allowed' : 'grab',
    transition: 'left 0.15s ease',
    'z-index': '2',
  }

  function handleTrackClick(e: MouseEvent) {
    if (local.disabled) return
    const track = e.currentTarget as HTMLDivElement
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    local.onChange(min + Math.round(ratio * (max - min) / step) * step)
  }

  return (
    <div class={local.class} style={{ width: '100%' }}>
      <div style={trackStyle} onClick={handleTrackClick}>
        <div style={fillStyle} />
        <div style={thumbStyle} />
      </div>
      {local.labels && (
        <div style={{
          display: 'flex', 'justify-content': 'space-between',
          'margin-top': '8px', 'font-size': '12px',
          color: 'var(--color-text-tertiary)',
        }}>
          {local.labels.map((label, i) => (
            <span key={i} style={{
              color: i === Math.round(((local.value - min) / (max - min)) * (local.labels!.length - 1))
                ? 'var(--color-blue-apple)' : 'var(--color-text-tertiary)',
              transition: 'color 0.15s',
            }}>{label}</span>
          ))}
        </div>
      )}
    </div>
  )
}
