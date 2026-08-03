export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | {
      readonly type: "tool"
      readonly toolName: string
    }

export function isForcedToolChoice(value: ToolChoice | undefined) {
  return value === "required" || (typeof value === "object" && value.type === "tool")
}
