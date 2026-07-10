import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { pipe, entries, filter, map, sortBy } from "remeda"

const ROLE_LABELS: Record<string, string> = {
  planner_model: "Planner",
  complex_model: "Complex Tasks",
  simple_model: "Simple Tasks",
  visual_model: "Visual / Documents",
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  planner_model: "Model used by the cluster primary agent for planning",
  complex_model: "Default model for complex cluster tasks",
  simple_model: "Default model for simple cluster tasks",
  visual_model: "Model used for visual, layout, chart, and document production tasks",
}

const ROLES = ["planner_model", "complex_model", "simple_model", "visual_model"] as const

export function DialogAgentCluster() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  const [selectedRole, setSelectedRole] = createSignal<string | null>(null)

  const clusterConfig = createMemo(() => sync.data.config.agent_cluster ?? {})

  function modelDisplay(modelStr: string | undefined): string {
    if (!modelStr) return "default"
    const slash = modelStr.indexOf("/")
    if (slash === -1) return modelStr
    const providerID = modelStr.slice(0, slash)
    const modelID = modelStr.slice(slash + 1)
    const provider = sync.data.provider.find((p) => p.id === providerID)
    const model = provider?.models[modelID]
    return model?.name ?? modelStr
  }

  function applyUpdate(role: string, providerID: string, modelID: string) {
    const modelStr = `${providerID}/${modelID}`
    const updated = { [role]: modelStr }
    sdk.client.global.config
      .update({ config: { agent_cluster: updated } })
      .then(() => {
        toast.show({
          message: `${ROLE_LABELS[role]} → ${modelDisplay(modelStr)} (saved globally)`,
          variant: "success",
          duration: 3000,
        })
        dialog.clear()
      })
      .catch((e) => {
        toast.show({
          message: `Failed to update: ${e instanceof Error ? e.message : String(e)}`,
          variant: "error",
          duration: 3000,
        })
      })
  }

  // --- Role list view ---
  const roleOptions = createMemo(() =>
    ROLES.map((role) => ({
      value: role,
      title: ROLE_LABELS[role],
      description: ROLE_DESCRIPTIONS[role],
      footer: modelDisplay(clusterConfig()[role]),
      onSelect: () => {
        setSelectedRole(role)
        dialog.replace(() => <ModelPickerView role={role} onSelect={applyUpdate} />)
      },
    })),
  )

  // If we somehow got here with a pre-selected role, show the picker directly
  const role = selectedRole()
  if (role) {
    return <ModelPickerView role={role} onSelect={applyUpdate} />
  }

  return <DialogSelect title="Configure Cluster Models" options={roleOptions()} flat={true} />
}

// --- Model picker sub-view ---
function ModelPickerView(props: { role: string; onSelect: (role: string, providerID: string, modelID: string) => void }) {
  const sync = useSync()

  const options = createMemo(() =>
    pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "jyycode",
        (provider) => provider.name,
      ),
      (providers) =>
        providers.flatMap((provider) =>
          pipe(
            provider.models,
            entries(),
            filter(([_, info]) => info.status !== "deprecated"),
            map(([modelID, info]) => ({
              value: { providerID: provider.id, modelID },
              title: info.name ?? modelID,
              description: provider.name,
              footer: info.cost?.input === 0 && provider.id === "jyycode" ? "Free" : undefined,
              onSelect: () => {
                props.onSelect(props.role, provider.id, modelID)
              },
            })),
          ),
        ),
      sortBy(
        (x) => x.footer !== "Free",
        (x) => x.title,
      ),
    ),
  )

  return (
    <DialogSelect<{ providerID: string; modelID: string }>
      title={`Select model for ${ROLE_LABELS[props.role]}`}
      options={options()}
      flat={true}
    />
  )
}
