import { useTheme } from "../context/theme"
import type { RGBA } from "@opentui/core"

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]

type ProgressBarProps = {
  /** Progress ratio 0..1 */
  ratio: number
  /** Width in characters */
  width: number
  /** Color for the filled portion */
  fillColor?: RGBA
  /** Color for the empty portion (background) */
  emptyColor?: RGBA
}

export function ProgressBar(props: ProgressBarProps) {
  const { theme } = useTheme()
  const fill = () => props.fillColor ?? theme.primary
  const empty = () => props.emptyColor ?? theme.backgroundElement

  const ratio = () => Math.min(1, Math.max(0, props.ratio))
  const segments = () => {
    const r = ratio()
    const w = props.width
    const whole = Math.floor(r * w)
    const result: string[] = [BLOCKS[BLOCKS.length - 1].repeat(whole)]
    if (whole < w) {
      const remainder = r * w - whole
      const middle = Math.floor(remainder * BLOCKS.length)
      result.push(BLOCKS[middle])
      const emptyCount = w - whole - 1
      if (emptyCount > 0) result.push(BLOCKS[0].repeat(emptyCount))
    }
    return result.join("")
  }

  return (
    <text fg={fill()}>
      <span style={{ bg: empty() }}>{segments()}</span>
    </text>
  )
}
