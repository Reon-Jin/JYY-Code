import { Slider } from '../ui/Slider'

interface Props {
  value: number
  onChange: (depth: number) => void
  variants?: string[]
}

function labelFor(value: string) {
  if (value === 'medium') return 'Med'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function ThinkingDepthSlider(props: Props) {
  const labels = () => ['Off', ...(props.variants ?? []).map(labelFor)]
  const max = () => Math.max(0, labels().length - 1)
  const value = () => Math.min(props.value, max())
  return (
    <div class="toolbar-control thinking-control" title={`Thinking depth: ${labels()[value()] ?? 'Off'}`}>
      <span class="control-label">Thinking</span>
      <Slider value={value()} min={0} max={max()} step={1} labels={labels()} onChange={props.onChange} disabled={max() === 0} />
    </div>
  )
}
