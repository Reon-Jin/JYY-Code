import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"

type NewMessagesPillProps = {
  /** Number of new messages since the user scrolled away. 0 = "Jump to bottom". */
  count: number
  /** Called when the pill is clicked. */
  onClick: () => void
}

export function NewMessagesPill(props: NewMessagesPillProps) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  const label = () => {
    if (props.count === 0) return "Jump to bottom"
    return `${props.count} new message${props.count !== 1 ? "s" : ""}`
  }

  const bg = () => (hover() ? theme.secondary : theme.primary)
  const fg = () => theme.background

  return (
    <box
      position="absolute"
      bottom={0}
      left={0}
      right={0}
      justifyContent="center"
      paddingBottom={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onClick}
    >
      <text fg={fg()}>
        <span style={{ bg: bg(), fg: fg(), bold: true }}> ↓ {label()} </span>
      </text>
    </box>
  )
}
