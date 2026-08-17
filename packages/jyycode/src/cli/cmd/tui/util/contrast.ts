// WCAG 2.x 相对亮度与对比度（供主题可读性校验使用）
import type { RGBA } from "@opentui/core"

function channel(value: number): number {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color: RGBA): number {
  return 0.2126 * channel(color.r * 255) + 0.7152 * channel(color.g * 255) + 0.0722 * channel(color.b * 255)
}

export function contrast(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export function contrastHex(a: string, b: string): number {
  const rgba = (hex: string): RGBA => {
    const c = hex.replace("#", "")
    const r = parseInt(c.slice(0, 2), 16)
    const g = parseInt(c.slice(2, 4), 16)
    const b = parseInt(c.slice(4, 6), 16)
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 } as RGBA
  }
  return contrast(rgba(a), rgba(b))
}
