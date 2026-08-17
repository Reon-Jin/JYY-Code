import { createEffect, createSignal, onCleanup, onMount, splitProps, type JSX } from "solid-js"
import { MODE_DRAWS } from "./engine/registry"
import { resolvePreset } from "./presets"
import type { ThinkingOrbProps } from "./types"

const LABELS: Record<string, string> = {
  working: "Working…",
  searching: "Searching…",
  solving: "Solving…",
  listening: "Listening…",
  connecting: "Connecting…",
  weaving: "Weaving…",
  composing: "Composing…",
  breathing: "Thinking…",
  shaping: "Shaping…",
  compacting: "Compacting…",
}

function ancestorTheme(el: Element | null): boolean | null {
  let node: Element | null = el
  while (node) {
    const attr = node.getAttribute("data-theme")
    if (attr === "dark") return true
    if (attr === "light") return false
    if (node.classList.contains("dark")) return true
    if (node.classList.contains("light")) return false
    node = node.parentElement
  }
  return null
}

function systemDark(): boolean {
  return typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches
}

/**
 * Solid port of the official thinking-orbs component.
 * The canvas engine, presets and painters are copied verbatim from the
 * upstream repository; only the React shell was translated to Solid.
 */
export function ThinkingOrb(props: ThinkingOrbProps) {
  const [local, rest] = splitProps(props, ["state", "size", "theme", "speed", "paused", "style", "class", "aria-label"])

  let canvas: HTMLCanvasElement | undefined
  const [dark, setDark] = createSignal(true)
  const [reduced, setReduced] = createSignal(false)

  // Theme resolution: explicit prop → ancestor data-theme/.dark|.light →
  // prefers-color-scheme, all watched live.
  createEffect(() => {
    const theme = local.theme ?? "auto"
    if (theme === "dark") {
      setDark(true)
      return
    }
    if (theme === "light") {
      setDark(false)
      return
    }

    const resolve = () => setDark(ancestorTheme(canvas ?? null) ?? systemDark())
    resolve()

    const mq = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null
    const onMq = () => resolve()
    mq?.addEventListener("change", onMq)

    let observer: MutationObserver | null = null
    if (typeof MutationObserver !== "undefined" && canvas) {
      observer = new MutationObserver(resolve)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
        subtree: true,
      })
    }

    onCleanup(() => {
      mq?.removeEventListener("change", onMq)
      observer?.disconnect()
    })
  })

  // Live prefers-reduced-motion — reduced users get a static frame.
  onMount(() => {
    if (typeof matchMedia === "undefined") return
    const mq = matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    mq.addEventListener("change", onChange)
    onCleanup(() => mq.removeEventListener("change", onChange))
  })

  // Canvas loop: paints one frame, pauses offscreen/hidden tab.
  createEffect(() => {
    const el = canvas
    if (!el) return

    const size = local.size ?? 64
    const dpr = Math.min(2, (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1)
    el.width = Math.round(size * dpr)
    el.height = Math.round(size * dpr)
    const ctx = el.getContext("2d")
    if (!ctx) return

    const { mode, speed: baseSpeed, opts } = resolvePreset(local.state ?? "working", size)
    const draw = MODE_DRAWS[mode]
    const effSpeed = baseSpeed * (local.speed ?? 1)
    const isDark = dark()
    const isPaused = local.paused ?? false
    const isReduced = reduced()

    const frame = (tSec: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, tSec, isDark, opts)
    }

    // Reduced motion → one static, deterministic frame.
    if (isReduced) {
      frame(0.6)
      return
    }

    let raf = 0
    let running = false
    const loop = () => {
      frame((performance.now() / 1000) * effSpeed)
      if (running) raf = requestAnimationFrame(loop)
    }
    const start = () => {
      if (running || isPaused) return
      running = true
      raf = requestAnimationFrame(loop)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }

    // Draw at least one frame even when paused/offscreen.
    frame((performance.now() / 1000) * effSpeed)

    let visible = true
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? false
            if (visible && document.visibilityState !== "hidden") start()
            else stop()
          })
        : null
    io?.observe(el)

    const onVis = () => {
      if (document.visibilityState === "hidden") stop()
      else if (visible) start()
    }
    document.addEventListener("visibilitychange", onVis)
    if (!io) start()

    onCleanup(() => {
      stop()
      io?.disconnect()
      document.removeEventListener("visibilitychange", onVis)
    })
  })

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={local["aria-label"] ?? LABELS[local.state ?? "working"]}
      class={local.class}
      style={
        {
          width: local.size ?? 64,
          height: local.size ?? 64,
          display: "block",
          ...(local.style ?? {}),
        } as JSX.CSSProperties
      }
      {...rest}
    />
  )
}

export default ThinkingOrb
