import { type JSX, splitProps } from 'solid-js'

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  labels?: string[] // label for each stop point
  disabled?: boolean
  class?: string
}

export function Slider(props: SliderProps) {
  const [local] = splitProps(props, ['value', 'min', 'max', 'step', 'onChange', 'labels', 'disabled', 'class'])
  const min = local.min ?? 0
  const max = local.max ?? 100
  const step = local.step ?? 1

  const ratio = () => (max === min ? 0 : ((local.value - min) / (max - min)) * 100)

  const trackStyle = (): JSX.CSSProperties => ({
    position: 'relative',
    width: '100%',
    height: '4px',
    'border-radius': '2px',
    background: 'rgba(176, 174, 165, 0.18)',
    cursor: local.disabled ? 'not-allowed' : 'pointer',
    opacity: local.disabled ? 0.5 : 1,
  })

  const fillStyle = (): JSX.CSSProperties => ({
    position: 'absolute',
    height: '100%',
    'border-radius': '2px',
    background: 'var(--clr-terracotta)',
    width: `${ratio()}%`,
    transition: 'width 0.15s ease',
  })

  const thumbStyle = (): JSX.CSSProperties => ({
    position: 'absolute',
    top: '50%',
    left: `${ratio()}%`,
    transform: 'translate(-50%, -50%)',
    width: '20px',
    height: '20px',
    'border-radius': '50%',
    background: 'var(--clr-ivory)',
    'box-shadow':
      '0 1px 4px rgba(0,0,0,0.24), 0px 0px 0px 1px var(--clr-ring-warm)',
    cursor: local.disabled ? 'not-allowed' : 'grab',
    transition: 'left 0.15s ease',
    'z-index': '2',
  })

  function handleTrackClick(e: MouseEvent) {
    if (local.disabled) return
    const track = e.currentTarget as HTMLDivElement
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    local.onChange(min + Math.round(ratio * (max - min) / step) * step)
  }

  return (
    <div class={local.class} style={{ width: '100%' }}>
      <div style={trackStyle()} onClick={handleTrackClick}>
        <div style={fillStyle()} />
        <div style={thumbStyle()} />
      </div>
      {local.labels && (
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'margin-top': '8px',
            'font-size': '12px',
            'font-family': 'var(--font-sans)',
            color: 'var(--clr-stone-gray)',
          }}
        >
          {local.labels.map((label, i) => (
            <span
              onClick={() => !local.disabled && local.onChange(min + i * step)}
              style={{
                color:
                  i ===
                  Math.round((ratio() / 100) * (local.labels!.length - 1))
                    ? 'var(--clr-coral)'
                    : 'var(--clr-stone-gray)',
                transition: 'color 0.15s',
                cursor: local.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
