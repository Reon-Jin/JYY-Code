export const zhCN = {
  "app.loading": "正在启动 JYYCode",
  "settings.general.title": "通用设置",
} as const

export type MessageKey = keyof typeof zhCN

export const enUS = {
  "app.loading": "Starting JYYCode",
  "settings.general.title": "General settings",
} as const satisfies Record<MessageKey, string>

export const messages = {
  "zh-CN": zhCN,
  "en-US": enUS,
} as const
