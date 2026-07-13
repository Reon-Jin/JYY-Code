import { Cable } from "lucide-solid"

export function ProviderEmpty(props: { configPath: string }) {
  return (
    <section class="provider-empty" aria-labelledby="provider-empty-title">
      <Cable aria-hidden="true" />
      <div>
        <strong id="provider-empty-title">没有可用的模型</strong>
        <p>请在全局配置中连接并启用至少一个 Provider，然后重启桌面应用。</p>
        <code>{props.configPath}</code>
      </div>
    </section>
  )
}
