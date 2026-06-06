import { RGBA } from "@opentui/core"

/**
 * Creates a lighter "shimmer" variant of a color by blending it toward white.
 * Used for glow/highlight animations in spinners, borders, and loading states.
 *
 * @param color - The base RGBA color
 * @param factor - Blend factor toward white (0 = no change, 1 = pure white). Default 0.3.
 * @returns A new RGBA with the same alpha, blended toward white
 */
export function shimmer(color: RGBA, factor: number = 0.3): RGBA {
  const r = color.r + (1 - color.r) * factor
  const g = color.g + (1 - color.g) * factor
  const b = color.b + (1 - color.b) * factor
  return RGBA.fromValues(r, g, b, color.a)
}

/**
 * Creates a subtle pulsing shimmer by blending toward white with a dynamic factor.
 * Use with animation frames (0..1 cycle) for a breathing glow effect.
 *
 * @param color - The base RGBA color
 * @param phase - Animation phase 0..1 (0=base color, 0.5=peak shimmer, 1=back to base)
 * @param intensity - Maximum shimmer intensity. Default 0.25.
 */
export function pulseShimmer(color: RGBA, phase: number, intensity: number = 0.25): RGBA {
  // Triangle wave: 0 -> 1 -> 0
  const factor = intensity * (1 - Math.abs(phase * 2 - 1))
  return shimmer(color, factor)
}
