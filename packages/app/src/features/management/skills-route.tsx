import { useParams } from "@solidjs/router"
import { Show } from "solid-js"
import SkillDetailPage from "../skills/skill-detail-page"
import SkillListPage from "../skills/skill-list-page"

export default function SkillsRoute() {
  const params = useParams<{ name?: string }>()
  return (
    <Show when={params.name} fallback={<SkillListPage />}>
      {(name) => <SkillDetailPage name={name()} />}
    </Show>
  )
}
