import type { JSX } from "solid-js"

/**
 * The nine shipped states — each a hand-tuned animation.
 */
export type OrbState =
  | "working"
  | "searching"
  | "solving"
  | "listening"
  | "connecting"
  | "weaving"
  | "composing"
  | "breathing"
  | "shaping"
  | "compacting"

/**
 * Rendered size in CSS pixels. Exactly two tuned presets ship:
 * 64 (chat-avatar scale) and 20 (inline-text scale).
 */
export type OrbSize = 64 | 20

/**
 * Theme mode.
 * - `auto` (default) resolves from an ancestor `data-theme`/class, then
 *   `prefers-color-scheme`, live-updating on change.
 * - `dark` / `light` pin the palette.
 */
export type OrbTheme = "auto" | "dark" | "light"

/** Props for the Solid ThinkingOrb component. */
export interface ThinkingOrbProps
  extends Omit<JSX.CanvasHTMLAttributes<HTMLCanvasElement>, "style" | "width" | "height"> {
  /** Which animation to show. @default 'working' */
  state?: OrbState

  /** Tuned size preset — 64 or 20 CSS px. @default 64 */
  size?: OrbSize

  /** Theme mode; `auto` detects from the host project. @default 'auto' */
  theme?: OrbTheme

  /**
   * Animation speed multiplier on top of the preset's baked speed.
   * @default 1
   */
  speed?: number

  /** Freeze the animation on the current frame. @default false */
  paused?: boolean

  style?: JSX.CSSProperties
}
