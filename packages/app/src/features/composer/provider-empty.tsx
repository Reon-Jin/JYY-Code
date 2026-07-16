import { tr } from "../../i18n/i18n-context"
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
        <strong id="provider-empty-title">{tr("composer.no-model-available")}</strong>
        <p>{tr("composer.please-connect-and-enable-at-least-one-provider")}</p>
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
