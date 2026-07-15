import { Cable } from "lucide-solid"
import type { DesktopClient } from "../../data/sdk"
import { ProviderConnectButton } from "./provider-connect"

export function ProviderEmpty(props: {
  client: Pick<DesktopClient, "auth" | "instance" | "provider">
  configPath: string
  directory: string
  disabled?: boolean
  onProviderConnected: (providerID: string) => void | Promise<void>
}) {
  return (
    <section class="provider-empty" aria-labelledby="provider-empty-title">
      <Cable aria-hidden="true" />
      <div>
        <strong id="provider-empty-title">没有可用的模型</strong>
        <p>请连接并启用至少一个 Provider。</p>
        <code>{props.configPath}</code>
        <ProviderConnectButton
          client={props.client}
          directory={props.directory}
          disabled={props.disabled}
          onConnected={props.onProviderConnected}
        />
      </div>
    </section>
  )
}
