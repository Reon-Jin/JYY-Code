# JYYCode Mobile (iOS)

This is the iOS 17+ SwiftUI companion application. On macOS, install
[XcodeGen](https://github.com/yonaskolb/XcodeGen), then run `xcodegen generate`
from this directory and open `JYYCodeMobile.xcodeproj` in Xcode.

The bundle identifier and `aps-environment` entitlement are development defaults.
Set the production team, provisioning profile, APNs key, and relay base URL before
installing on a physical device.

## Release handoff

1. In the Apple Developer portal, create the `ai.jyycode.mobile` App ID and
   enable Push Notifications. Select the paid development team in Xcode.
2. Generate the project with `xcodegen generate`, then run the `JYYCodeMobileTests`
   target and install on a physical iPhone over cellular data.
3. Deploy `packages/relay` behind HTTPS/WSS. Set `JYYCODE_PUSH_GATEWAY_URL` to
   the APNs sender owned by the deployment. The relay posts only
   `{ token, kind }`, where `kind` is `attention`, `failed`, or `completed`;
   the sender must produce a generic APNs alert and must never add task text,
   paths, source code, credentials, or authorization headers.

The relay itself does not persist task data or queue commands. Its health check
is available at `/health`; expose it through the deployment health probe.
