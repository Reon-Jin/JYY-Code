# JYY-Code Privacy Policy

Effective date: July 18, 2026

This policy describes how the open-source JYY-Code application handles information. JYY-Code can be used locally without creating a JYY-Code account. The project maintainers do not operate product analytics or remote telemetry by default.

## Data stored on your device

Depending on the features you use, JYY-Code stores application settings, project paths, sessions, messages, tool results, task history, durable memory, logs, and related metadata in local configuration files and databases. Provider credentials and OAuth tokens are stored locally in a restricted authentication file.

This local data remains under your control unless you choose a feature or external service that transmits it.

## Data sent to external services

JYY-Code connects to external services only as needed for configured or user-requested features. Those connections may include:

- AI providers you select. Prompts, conversation context, code, attachments, tool results, and provider credentials may be sent to that provider to answer your request.
- GitHub, other Git hosts, and package registries when you use repository, release, update, dependency, plugin, or package features.
- The official GitHub Releases endpoint when the desktop application checks for updates according to your update setting.
- MCP servers, web services, email servers, language servers, or other integrations that you explicitly configure or invoke.
- A configured JYY-Code sharing service when you explicitly share a session or enable automatic session sharing. Shared session data can then be accessed through the generated link until it is unshared or removed by the service.

Network services normally receive technical connection data such as your IP address, request time, and user agent. Each external service processes data under its own terms and privacy policy. Do not send secrets or personal information to a provider unless you trust that provider and intend it to process that information.

## Optional telemetry

OpenTelemetry export is optional and is not enabled by JYY-Code by default. If you configure and enable it, diagnostic or operational data is sent to the telemetry destination you selected. That destination's retention and access rules apply.

## Retention and deletion

Local data remains on your device until you delete it, remove the relevant configuration or database, or uninstall JYY-Code and choose to remove its data. You can use `jyycode db status` to locate the active database. You can disconnect providers, revoke credentials with the provider, disable integrations or update checks, unshare shared sessions, and delete local application data.

Data sent to an external provider is retained according to that provider's policy and your account settings. Requests to access or delete that data should be directed to the provider that received it.

## Security

JYY-Code limits its local authentication file to the current user where the operating system supports those permissions. No storage or transmission method is completely secure, so you should protect your operating-system account, keep credentials out of project files and prompts, and revoke any credential you believe has been exposed.

## Changes and contact

Material changes to this policy will be published in this repository with an updated effective date. For privacy questions, open an issue in the [JYY-Code GitHub repository](https://github.com/Reon-Jin/JYY-Code/issues). Do not include passwords, API keys, access tokens, or other sensitive data in a public issue.
