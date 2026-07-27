# JYYCode relay deployment

The relay routes opaque WebSocket envelopes at `/connect` and serves a health
probe at `/health`. It does not store task content, code, command payloads or
offline commands.

Safari/PWA clients connect as an opaque `web` peer after QR pairing. The relay
only sees route identifiers, connection state, rate-limit counters, encrypted
envelopes and optional generic notification metadata. It must never log or
persist decrypted task text, project paths, source code, credentials, or
authorization headers.

Build from the repository root:

```sh
docker build -f packages/relay/Dockerfile -t jyycode-relay .
docker run --rm -p 8787:8787 jyycode-relay
```

Deploy behind a managed HTTPS reverse proxy or platform load balancer that
terminates TLS and forwards WebSocket upgrades. Set the desktop relay URL to
`wss://<your-domain>/connect`; do not expose an unencrypted public `ws://`
endpoint.

For native push delivery, set `JYYCODE_PUSH_GATEWAY_URL` to an internal APNs sender.
The relay posts only `{ token, kind }`, where `kind` is `attention`, `failed`,
or `completed`. The APNs sender must use the registered App ID/topic and emit
a generic alert without task titles, source code, paths, secrets, or headers.
Safari foreground updates use the encrypted WebSocket. Do not advertise
background web notifications until the PWA is deployed over HTTPS and a
separate Web Push sender has been configured.
