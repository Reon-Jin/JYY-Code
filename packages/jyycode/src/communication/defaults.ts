export const DEFAULT_EMAIL_TO = "owner@example.com"

export function defaultEmailRecipient(config: {
  communication?: { finish?: { to?: string }; inbox?: { owner?: string } }
}) {
  return config.communication?.finish?.to ?? config.communication?.inbox?.owner ?? DEFAULT_EMAIL_TO
}
