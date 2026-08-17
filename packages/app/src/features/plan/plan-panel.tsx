import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import { MultiAgentPanelView } from "../multi-agent/multi-agent-panel"
import { planQueryOptions } from "./plan-query"
import { projectPlanState } from "./plan-state"

export function PlanPanel(props: {
  directory: string
  sessionID?: string
  rootSessionID?: string
  selectedChildSessionID?: string
  onOpenChild: (sessionID: string) => void
}) {
  const data = useData()
  const planQuery = createQuery(
    () => ({
      ...planQueryOptions({
        client: data.client(),
        directory: props.directory,
        sessionID: props.rootSessionID ?? "",
      }),
      enabled: Boolean(props.rootSessionID),
    }),
    data.queryClient,
  )
  const snapshot = createMemo(() => projectPlanState(planQuery.data ?? { plan: null }))

  return (
    <MultiAgentPanelView
      sessionID={props.rootSessionID}
      enabled
      snapshot={snapshot()}
      selectedChildSessionID={props.selectedChildSessionID}
      title={tr("workspace-inspector.plan")}
      progressLabel={tr("plan.progress")}
      waitingForPlanMessage={tr("plan.waiting-for-plan")}
      noPlanMessage={tr("plan.no-plan")}
      loading={Boolean(props.rootSessionID) && planQuery.isPending}
      error={planQuery.error ? errorMessage(planQuery.error, tr("plan.unable-to-load-plan")) : undefined}
      onRetry={() => void planQuery.refetch()}
      onOpenChild={props.onOpenChild}
    />
  )
}
