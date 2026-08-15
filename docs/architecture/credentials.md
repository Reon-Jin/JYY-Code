# Credential boundary architecture

Provider configuration identifies how to call a model. Credential storage
holds secret material. The two are deliberately separate so a request
envelope, session event, replay, SDK response, or telemetry record can carry a
stable reference without carrying a secret.

## Ownership matrix

| Structure | Owner | Create/update contract | Rebuild or recovery | Delete/cleanup |
| --- | --- | --- | --- | --- |
| `CredentialRef` | Core credential contract | Auth creates a value-free `{providerID, credentialID, kind}` reference | Recompute from the provider and credential metadata; a reference never reconstructs the secret | Remove the auth entry and invalidate the reference; do not scrub historical references by rewriting events |
| Auth record | Product `Auth.Service` and its durable auth store | `set`/`remove` update the provider's API, OAuth, or well-known credential record | Restore the auth file/database backup; validate the reference ID and kind before use | Delete through `Auth.Service`; never delete by scanning arbitrary files |
| Provider configuration | Product config/provider service | Configuration stores provider options and an optional `CredentialRef`; it never owns secret resolution | Decode the config and rerun the compatibility migration if needed | Remove the provider config or reference; the auth record has an independent lifecycle |
| Resolved credential | `Credential.Service` at the provider execution boundary | Resolve a reference immediately before the model request | Re-resolve on retry; never persist the returned secret | Drop the value after the request/fiber scope ends |
| External extension | Provider adapter, SDK, MCP, or plugin | Receives a reference or a short-lived resolved value only through its documented port | Reconnect using the reference; it cannot read the auth store directly | The kernel revokes access by removing or rotating the auth record |

## Compatibility rule

During the migration window, the config decoder accepts an inline provider
`apiKey` only to migrate it into the auth store, emit a deprecation warning,
and replace it with a `CredentialRef`. The compatibility decoder is the only
place allowed to see that legacy shape. Normal runtime configuration and model
request schemas contain the reference, not the secret.

The provider runtime resolves the reference inside the request effect. Redacted
status views may report provider and credential IDs, but never key contents,
OAuth refresh/access tokens, or environment snapshots containing them.
