import type { ToolDisclosureConfig, ToolDisclosureItem } from "@jyycode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"

type Mode = "direct" | "deferred"

export function toggleToolDisclosure(
  policy: ToolDisclosureConfig | undefined,
  tool: Pick<ToolDisclosureItem, "id" | "mode">,
) {
  const mode: Mode = tool.mode === "direct" ? "deferred" : "direct"
  return { policy: { ...(policy ?? {}), [tool.id]: mode }, mode }
}

function Status(props: { mode: Mode; saving: boolean }) {
  const { theme } = useTheme()
  if (props.saving) return <span style={{ fg: theme.textMuted }}>Saving...</span>
  if (props.mode === "direct") {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>Direct</span>
  }
  return <span style={{ fg: theme.warning, attributes: TextAttributes.BOLD }}>Deferred</span>
}

export function DialogTools() {
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const [saving, setSaving] = createSignal<string>()
  const [inventory, { mutate }] = createResource(async () => {
    const result = await sdk.client.tool.disclosure(undefined, { throwOnError: true })
    return result.data
  })

  async function toggle(item: ToolDisclosureItem) {
    if (saving() || !item.configurable) return
    const next = toggleToolDisclosure(sync.data.config.tool_disclosure, item)
    setSaving(item.id)
    try {
      await sdk.client.config.update({ config: { tool_disclosure: next.policy } }, { throwOnError: true })
      sync.set("config", "tool_disclosure", next.policy)
      mutate((items) =>
        items?.map((candidate) =>
          candidate.id === item.id ? { ...candidate, configured: next.mode, mode: next.mode } : candidate,
        ),
      )
      toast.show({
        message: `${item.id} is now ${next.mode}`,
        variant: "success",
        duration: 2000,
      })
    } catch (error) {
      toast.show({
        message: `Failed to save tool disclosure: ${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
        duration: 4000,
      })
    } finally {
      setSaving(undefined)
    }
  }

  const options = createMemo<DialogSelectOption<ToolDisclosureItem>[]>(() => {
    if (inventory.loading) {
      return [{ value: {} as ToolDisclosureItem, title: "Loading tools...", disabled: true }]
    }
    if (inventory.error) {
      return [
        {
          value: {} as ToolDisclosureItem,
          title: "Failed to load tools",
          description: String(inventory.error),
          disabled: true,
        },
      ]
    }
    return (inventory() ?? []).map((item) => ({
      value: item,
      title: item.id,
      description: item.description,
      category: item.source === "mcp" ? `MCP / ${item.category ?? "other"}` : (item.category ?? "other"),
      footer: <Status mode={item.mode} saving={saving() === item.id} />,
      disabled: !item.configurable,
    }))
  })

  return (
    <DialogSelect
      title="Tool Disclosure"
      placeholder="Search tools..."
      options={options()}
      actions={[
        {
          command: "dialog.tools.toggle",
          title: "toggle",
          onTrigger: (option) => void toggle(option.value),
        },
      ]}
      onSelect={(option) => void toggle(option.value)}
    />
  )
}
