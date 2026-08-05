import { createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { getPulseDriverConfig, generateBeamCSS, sizePresets, sizeThemePresets } from "./styles"
import { registerPulseInstance } from "./pulseDriver"
import type { BorderBeamProps, BorderBeamTheme } from "./types"

let beamIdCounter = 0

function useSystemTheme() {
  const [theme, setTheme] = createSignal<"dark" | "light">(
    typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "light"
      : "dark",
  )

  onMount(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light")
    mediaQuery.addEventListener("change", handler)
    onCleanup(() => mediaQuery.removeEventListener("change", handler))
  })

  return theme
}

function resolveTheme(theme: BorderBeamTheme | undefined, systemTheme: () => "dark" | "light") {
  return theme === "auto" ? systemTheme() : (theme ?? "dark")
}

/**
 * Solid port of the official border-beam component.
 * The CSS generation and pulse driver are copied verbatim from the upstream
 * repository; only the React shell was translated to Solid primitives.
 */
export function BorderBeam(props: BorderBeamProps) {
  const id = `solid-beam-${++beamIdCounter}`
  const systemTheme = useSystemTheme()

  const [isActive, setIsActive] = createSignal(props.active ?? true)
  const [isFading, setIsFading] = createSignal(false)
  const [isVisible, setIsVisible] = createSignal(true)
  const [detectedRadius, setDetectedRadius] = createSignal<number | null>(null)
  const [pulseGlowScale, setPulseGlowScale] = createSignal({ x: 1, y: 1 })

  let rootRef: HTMLDivElement | undefined

  const setRefs = (node: HTMLDivElement) => {
    rootRef = node
    const ref = props.ref
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }

  onMount(() => {
    const el = rootRef
    if (!el) return

    if (props.borderRadius == null) {
      const detect = () => {
        const child = el.firstElementChild as HTMLElement | null
        if (!child) return
        const computed = getComputedStyle(child)
        const raw = Number.parseFloat(computed.borderTopLeftRadius)
        if (!Number.isNaN(raw) && raw > 0) setDetectedRadius(raw)
      }

      detect()
      const observer = new MutationObserver(detect)
      observer.observe(el, { childList: true, subtree: false })
      onCleanup(() => observer.disconnect())
    }

    if (typeof IntersectionObserver === "undefined") return
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setIsVisible(entry.isIntersecting)
      },
      { rootMargin: "256px" },
    )
    intersectionObserver.observe(el)
    onCleanup(() => intersectionObserver.disconnect())
  })

  createEffect(() => {
    const active = props.active ?? true
    if (active && !isActive() && !isFading()) setIsActive(true)
    else if (!active && isActive() && !isFading()) setIsFading(true)
  })

  createEffect(() => {
    const size = props.size ?? "md"
    if (size !== "pulse-outside") {
      setPulseGlowScale({ x: 1, y: 1 })
      return
    }

    const el = rootRef
    if (!el) return

    const REF_WIDTH = 350
    const REF_HEIGHT = 140
    const MIN_SCALE = 0.35
    const MAX_SCALE = 4
    const clamp = (value: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value))

    const measure = () => {
      const child = el.firstElementChild as HTMLElement | null
      if (!child) return
      const rect = child.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const x = +clamp(rect.width / REF_WIDTH).toFixed(3)
      const y = +clamp(rect.height / REF_HEIGHT).toFixed(3)
      setPulseGlowScale((previous) => (previous.x === x && previous.y === y ? previous : { x, y }))
    }

    measure()
    if (typeof ResizeObserver === "undefined") return
    const child = el.firstElementChild as HTMLElement | null
    if (!child) return
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(child)
    onCleanup(() => resizeObserver.disconnect())
  })

  const handleAnimationEnd = (event: AnimationEvent) => {
    const animationName = event.animationName

    if (animationName.includes("fade-out")) {
      setIsActive(false)
      setIsFading(false)
      props.onDeactivate?.()
    } else if (animationName.includes("fade-in")) {
      props.onActivate?.()
    }

    props.onAnimationEnd?.(event)
  }

  const resolvedTheme = () => resolveTheme(props.theme, systemTheme)
  const size = () => props.size ?? "md"
  const themeConfig = createMemo(() => sizeThemePresets[size()][resolvedTheme()])
  const sizeConfig = () => sizePresets[size()]
  const isPulse = () => size() === "pulse-inner" || size() === "pulse-outside"

  const finalBorderRadius = () => props.borderRadius ?? detectedRadius() ?? sizeConfig().borderRadius
  const finalDuration = () => props.duration ?? (size() === "line" ? 3.1 : isPulse() ? 2.3 : 1.96)
  const finalSaturation = () => props.saturation ?? themeConfig().saturation
  const finalBrightness = () => props.brightness ?? themeConfig().brightness ?? 1.3
  const finalHueRange = () => (size() === "line" ? Math.min(props.hueRange ?? 30, 13) : (props.hueRange ?? 30))
  const finalStaticColors = () => (props.colorVariant === "mono" ? true : props.staticColors ?? false)

  const cssStyles = createMemo(() =>
    generateBeamCSS({
      id,
      borderRadius: finalBorderRadius(),
      borderWidth: sizeConfig().borderWidth,
      duration: finalDuration(),
      strokeOpacity: themeConfig().strokeOpacity,
      innerOpacity: themeConfig().innerOpacity,
      bloomOpacity: themeConfig().bloomOpacity,
      innerShadow: themeConfig().innerShadow,
      size: size(),
      colorVariant: props.colorVariant ?? "colorful",
      staticColors: finalStaticColors(),
      brightness: finalBrightness(),
      saturation: finalSaturation(),
      hueRange: finalHueRange(),
      theme: resolvedTheme(),
      hairlineOpacity: themeConfig().hairlineOpacity,
    }),
  )

  const driverConfig = createMemo(() =>
    isPulse()
      ? getPulseDriverConfig(
          size(),
          resolvedTheme(),
          finalDuration(),
          finalHueRange(),
          finalStaticColors(),
          id,
        )
      : null,
  )

  createEffect(() => {
    const config = driverConfig()
    if (!config) return
    if (!(isActive() || isFading()) || !isVisible()) return

    const el = rootRef
    if (!el) return

    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

    return registerPulseInstance(el, config)
  })

  const mergedStyle = () =>
    ({
      ...(props.style ?? {}),
      "--beam-strength": Math.max(0, Math.min(1, props.strength ?? 1)),
      ...(size() === "pulse-outside"
        ? { "--pulse-glow-sx": pulseGlowScale().x, "--pulse-glow-sy": pulseGlowScale().y }
        : {}),
    }) as JSX.CSSProperties

  return (
    <>
      <style>{cssStyles()}</style>
      <div
        ref={setRefs}
        data-beam={id}
        data-active={isActive() && !isFading() ? "" : undefined}
        data-fading={isFading() ? "" : undefined}
        data-paused={isActive() && !isFading() && !isVisible() ? "" : undefined}
        class={props.class}
        style={mergedStyle()}
        onanimationend={handleAnimationEnd}
      >
        {props.children}
        <div data-beam-bloom />
      </div>
    </>
  )
}

export default BorderBeam
