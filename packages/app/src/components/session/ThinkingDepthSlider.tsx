import { Slider } from '../ui/Slider'

interface Props {
  value: number
  onChange: (depth: number) => void
}

const labels = ['Off', 'Low', 'Med', 'High']

export function ThinkingDepthSlider(props: Props) {
  return (
    <div class="toolbar-control thinking-control" title={`Thinking depth: ${labels[props.value] ?? 'Med'}`}>
      <span class="control-label">Thinking</span>
      <Slider value={props.value} min={0} max={3} step={1} labels={labels} onChange={props.onChange} />
    </div>
  )
}
