import { useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft } from "lucide-solid"
import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import { renderMarkdown } from "../conversation/markdown"
import { useManagement, type ManagementContextValue } from "../management/management-context"
import { SkillDeleteDialog } from "./skill-delete-dialog"
import { SkillEditor } from "./skill-editor"
import { managementSkillsQueryOptions, refreshManagementSkills, type ManagedSkill } from "./skill-query"
import "./skills.css"

export function SkillDetailPage(props: { management?: ManagementContextValue; name: string }) {
  const management = props.management ?? useManagement()
  const navigate = useNavigate()
  const [editing, setEditing] = createSignal(false)
  const [deleteOpen, setDeleteOpen] = createSignal(false)
  const query = createQuery(
    () => managementSkillsQueryOptions({ client: management.client, directory: management.directory }),
    () => management.queryClient,
  )
  const skill = createMemo(() => query.data?.find((item) => item.name === props.name))
  const preview = createMemo(() => renderMarkdown(skill()?.content ?? ""))
  const sourceRemoval = (value: ManagedSkill) =>
    (value.origin === "url" || value.origin === "path") && Boolean(value.source)

  return (
    <main class="skill-page skill-detail">
      <button type="button" class="skill-back" onClick={() => navigate("/skills")}>
        <ArrowLeft aria-hidden="true" />
        返回 Skill
      </button>
      <Show
        when={!query.isPending}
        fallback={
          <p class="skill-state" role="status">
            正在加载 Skill…
          </p>
        }
      >
        <Show
          when={!query.error}
          fallback={
            <div class="skill-state">
              <InlineError message={query.error instanceof Error ? query.error.message : "无法加载 Skill"} />
              <Button size="small" variant="secondary" onClick={() => void query.refetch()}>
                重试
              </Button>
            </div>
          }
        >
          <Show
            when={skill()}
            fallback={
              <div class="skill-state">
                <InlineError message="Skill 不存在" />
              </div>
            }
          >
            {(current) => (
              <>
                <header class="skill-detail__header">
                  <div>
                    <h1>{current().name}</h1>
                    <p>{current().description || "无描述"}</p>
                    <code>{current().location}</code>
                  </div>
                  <div class="skill-detail__actions">
                    <Show when={current().editable}>
                      <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
                        编辑
                      </Button>
                    </Show>
                    <Show when={current().deletable || sourceRemoval(current())}>
                      <Button size="small" variant="danger" onClick={() => setDeleteOpen(true)}>
                        {sourceRemoval(current()) ? "移除来源" : "删除"}
                      </Button>
                    </Show>
                  </div>
                </header>
                <Show
                  when={!editing()}
                  fallback={
                    <SkillEditor
                      skill={current()}
                      onCancel={() => setEditing(false)}
                      onSave={async (content, revision) => {
                        const response = await management.client.skill.update(
                          { directory: management.directory, name: current().name, content, revision },
                          { throwOnError: true },
                        )
                        if (response.data) {
                          const saved = response.data
                          management.queryClient.setQueryData(
                            keys.managementSkills,
                            (items: ManagedSkill[] | undefined) =>
                              items?.map((item) => (item.name === saved.name ? saved : item)),
                          )
                        }
                        await refreshManagementSkills(management.queryClient, current().name)
                        setEditing(false)
                      }}
                    />
                  }
                >
                  <article class="skill-preview" innerHTML={preview()} />
                </Show>
                <SkillDeleteDialog
                  open={deleteOpen()}
                  skill={current()}
                  sourceRemoval={sourceRemoval(current())}
                  onClose={() => setDeleteOpen(false)}
                  onConfirm={async () => {
                    if (sourceRemoval(current())) {
                      await management.client.skill.source.remove(
                        {
                          directory: management.directory,
                          type: current().origin as "path" | "url",
                          value: current().source!,
                        },
                        { throwOnError: true },
                      )
                    } else {
                      await management.client.skill.delete(
                        { directory: management.directory, name: current().name },
                        { throwOnError: true },
                      )
                    }
                    await refreshManagementSkills(management.queryClient, current().name)
                    navigate("/skills")
                  }}
                />
              </>
            )}
          </Show>
        </Show>
      </Show>
    </main>
  )
}

export default SkillDetailPage
