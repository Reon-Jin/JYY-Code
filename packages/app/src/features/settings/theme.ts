import type { ColorTheme } from "./settings-preferences"

export function applyTheme(theme: ColorTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme
}
