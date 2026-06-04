import { Slider } from '../ui/Slider'

interface Props {
  value: number
  onChange: (depth: number) => void
}

const labels = ['极少', '标准', '深度', '极限']

export function ThinkingDepthSlider(props: Props) {
  return (
    <div style={{
      display: 'flex',
      'align-items': 'center',
      gap: 'var(--space-8)',
      padding: '4px 12px',
      'border-radius': 'var(--radius-standard)',
      background: 'rgba(255,255,255,0.12)',
      'min-width': '160px',
    }}>
      <span style={{ 'font-size': '14px' }}>💭</span>
      <Slider
        value={props.value}
        min={0}
        max={3}
        step={1}
        labels={labels}
        onChange={props.onChange}
      />
    </div>
  )
}
