# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Current status

JYY-Code is preparing an application to the SignPath Foundation program. Until the application is approved and the signing pipeline is enabled, Windows release artifacts are **not** Authenticode-signed. Each GitHub Release states the signing status of its own artifacts.

Tauri updater signatures (`.sig` files) authenticate update packages inside JYY-Code, but they are not Windows Authenticode signatures and do not establish a Windows publisher identity.

## Roles and responsibilities

- Committers and reviewers: [Reon-Jin](https://github.com/Reon-Jin)
- Approvers: [Reon-Jin](https://github.com/Reon-Jin)

Committers maintain the source and release workflow and review changes before release. Approvers confirm that each signing request corresponds to an authorized JYY-Code release. Multi-factor authentication is required for accounts with repository or signing access.

## Signing and release process

After SignPath approval and pipeline activation:

1. Release artifacts will be built from the public JYY-Code repository by the documented GitHub Actions release workflow.
2. A SignPath signing request will be created only for artifacts produced from JYY-Code source and its declared dependencies.
3. Every release signing request will require manual approval by an approver.
4. Signed artifacts will be published on the official [GitHub Releases page](https://github.com/Reon-Jin/JYY-Code/releases).
5. Release notes will identify whether the attached Windows artifacts are Authenticode-signed.

The project will not submit third-party binaries or artifacts from unverifiable build origins for signing. Any change to signing roles or this process will be recorded in this policy.

## Privacy

The signing workflow processes release artifacts and build metadata; it is not used to collect end-user content. JYY-Code's handling of application data is described in the [Privacy Policy](PRIVACY.md).
