import { GripHorizontal } from "lucide-solid"
import { onCleanup } from "solid-js"
import { clampInspectorRatio } from "./inspector-preferences"

type SplitBounds = Pick<DOMRect, "top" | "height">

export type ResizableSplitProps = {
  value: number
  onChange: (value: number) => void
  getBounds?: () => SplitBounds
}

export function ResizableSplit(props: ResizableSplitProps) {
  let separator: HTMLDivElement | undefined
  let pointerID: number | undefined

  const update = (value: number) => props.onChange(clampInspectorRatio(value))
  const percent = () => Math.round(clampInspectorRatio(props.value) * 100)

  function bounds() {
    return props.getBounds?.() ?? separator?.parentElement?.getBoundingClientRect()
  }

  function move(event: PointerEvent) {
    if (pointerID !== event.pointerId) return
    const rect = bounds()
    if (!rect || rect.height <= 0) return
    update((event.clientY - rect.top) / rect.height)
  }

  function stop(event: PointerEvent) {
    if (pointerID !== event.pointerId) return
    pointerID = undefined
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", stop)
    window.removeEventListener("pointercancel", stop)
  }

  function start(event: PointerEvent) {
    pointerID = event.pointerId
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    event.preventDefault()
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "ArrowUp") update(props.value - 0.02)
    else if (event.key === "ArrowDown") update(props.value + 0.02)
    else if (event.key === "Home") update(0.2)
    else if (event.key === "End") update(0.8)
    else return
    event.preventDefault()
  }

  onCleanup(() => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", stop)
    window.removeEventListener("pointercancel", stop)
  })

  return (
    <div
      ref={separator}
      class="workspace-inspector__separator"
      role="separator"
      tabIndex={0}
      aria-label="调整计划与工作区变更高度"
      aria-orientation="horizontal"
      aria-valuemin="20"
      aria-valuemax="80"
      aria-valuenow={percent()}
      onPointerDown={start}
      onKeyDown={keydown}
    >
      <GripHorizontal aria-hidden="true" />
    </div>
  )
}
