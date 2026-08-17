export type PaperPalette = {
  surface: string
  raised: string
  control: string
  border: string
  borderStrong: string
  surfaceHover: string
  accent: string
  accentHover: string
  accentInk: string
  text: string
  textMuted: string
  codeBg: string
  codeText: string
  danger: string
  dangerSurface: string
  dangerInk: string
  warning: string
  success: string
  info: string
}

// Light = 与 packages/app/src/styles/tokens.css 逐值一致（防漂移测试锚点）
export const paperLight: PaperPalette = {
  surface: "#efede7",
  raised: "#f7f5ef",
  control: "#e7e4da",
  border: "#dbd8ca",
  borderStrong: "#c9c5b9",
  surfaceHover: "#e0ddcf",
  accent: "#475a74",
  accentHover: "#3a4a60",
  accentInk: "#f8f7f3",
  text: "#212428",
  textMuted: "#686a6f",
  codeBg: "#e9e6da",
  codeText: "#2b2e33",
  danger: "#9c4a3d",
  dangerSurface: "#f6e9e5",
  dangerInk: "#7c382c",
  warning: "#775c2f",
  success: "#40674f",
  info: "#475a74",
}

// Dark = 同一纸色族：暖近黑底 + 提亮灰蓝 accent（desktop 未来深色主题的基准）
export const paperDark: PaperPalette = {
  surface: "#1b1c1e",
  raised: "#222327",
  control: "#2a2b2f",
  border: "#3a3b40",
  borderStrong: "#4a4b51",
  surfaceHover: "#313237",
  accent: "#8fa3bd",
  accentHover: "#a7b8cf",
  accentInk: "#17181a",
  text: "#f2f0ea",
  textMuted: "#a6a49c",
  codeBg: "#26272b",
  codeText: "#e8e6df",
  danger: "#c47a6d",
  dangerSurface: "#38292a",
  dangerInk: "#e6b3a9",
  warning: "#c0a06a",
  success: "#7fa88e",
  info: "#8fa3bd",
}

// TUI theme JSON（与 packages/jyycode/src/cli/cmd/tui/context/theme.tsx 的 ThemeJson 对齐）
export type TuiThemeJson = {
  $schema?: string
  defs?: Record<string, string>
  theme: Record<string, string | { dark: string; light: string } | number>
}

export function tuiTheme(palette: PaperPalette): TuiThemeJson {
  const diffAddedBg = palette.danger === paperLight.danger ? "#e7ede4" : "#22302a"
  const diffRemovedBg = palette.dangerSurface
  return {
    $schema: "https://jyycode.ai/theme.json",
    defs: {
      bg: palette.surface,
      bgPanel: palette.raised,
      bgElement: palette.control,
      borderSubtle: palette.border,
      border: palette.borderStrong,
      accent: palette.accent,
      accentHover: palette.accentHover,
      accentInk: palette.accentInk,
      text: palette.text,
      textMuted: palette.textMuted,
      codeBg: palette.codeBg,
      codeText: palette.codeText,
      danger: palette.danger,
      dangerInk: palette.dangerInk,
      warning: palette.warning,
      success: palette.success,
      info: palette.info,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg: palette.raised,
    },
    theme: {
      primary: "accent",
      secondary: "accentHover",
      accent: "accent",
      error: "danger",
      warning: "warning",
      success: "success",
      info: "info",
      text: "text",
      textMuted: "textMuted",
      selectedListItemText: "accentInk",
      background: "bg",
      backgroundPanel: "bgPanel",
      backgroundElement: "bgElement",
      backgroundMenu: "bgPanel",
      borderSubtle: "borderSubtle",
      border: "border",
      borderActive: "accent",
      diffAdded: "success",
      diffRemoved: "danger",
      diffContext: "textMuted",
      diffHunkHeader: "textMuted",
      diffHighlightAdded: "success",
      diffHighlightRemoved: "danger",
      diffAddedBg: "diffAddedBg",
      diffRemovedBg: "diffRemovedBg",
      diffContextBg: "diffContextBg",
      diffLineNumber: "textMuted",
      diffAddedLineNumberBg: "diffAddedBg",
      diffRemovedLineNumberBg: "diffRemovedBg",
      markdownText: "text",
      markdownHeading: "text",
      markdownLink: "accent",
      markdownLinkText: "accent",
      markdownCode: "success",
      markdownBlockQuote: "textMuted",
      markdownEmph: "textMuted",
      markdownStrong: "text",
      markdownHorizontalRule: "border",
      markdownListItem: "accent",
      markdownListEnumeration: "accent",
      markdownImage: "accent",
      markdownImageText: "accent",
      markdownCodeBlock: "codeText",
      syntaxComment: "textMuted",
      syntaxKeyword: "accent",
      syntaxFunction: "accentHover",
      syntaxVariable: "text",
      syntaxString: "success",
      syntaxNumber: "warning",
      syntaxType: "accent",
      syntaxOperator: "accent",
      syntaxPunctuation: "text",
      thinkingOpacity: 0.6,
    },
  }
}

// desktop CSS 变量（与 tokens.css 命名一致；用于生成与防漂移测试）
export function cssVars(palette: PaperPalette): Record<string, string> {
  return {
    "--surface-solid": palette.surface,
    "--surface-raised-solid": palette.raised,
    "--surface-control-solid": palette.control,
    "--surface-border-solid": palette.border,
    "--color-surface-hover": palette.surfaceHover,
    "--color-accent": palette.accent,
    "--color-accent-hover": palette.accentHover,
    "--color-accent-ink": palette.accentInk,
    "--color-text": palette.text,
    "--color-text-muted": palette.textMuted,
    "--color-code-bg": palette.codeBg,
    "--color-code-text": palette.codeText,
    "--color-border-strong": palette.borderStrong,
    "--color-danger": palette.danger,
    "--color-danger-surface": palette.dangerSurface,
    "--color-danger-ink": palette.dangerInk,
    "--color-warning": palette.warning,
    "--color-success": palette.success,
  }
}
