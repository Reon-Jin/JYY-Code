import { tr } from "../../i18n/i18n-context"
import type { ParentProps } from "solid-js"

export function ComingSoonSetting(props: ParentProps<{ title: string; reason: string }>) {
  return (
    <article class="coming-soon-setting" aria-disabled="true">
      <header>
        <h3>{props.title}</h3>
        <span class="settings-badge">{tr("settings.coming-soon")}</span>
      </header>
      <div class="coming-soon-setting__control">{props.children}</div>
      <p>{props.reason}</p>
    </article>
  )
}
