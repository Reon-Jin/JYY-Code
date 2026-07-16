# Desktop Settings Phase Two Acceptance

**Date:** 2026-07-16
**Branch:** `codex/desktop-settings-phase-two`

## Scope decision

Task 13 is completed with Tasks 11 and 12 intentionally skipped at the user's request. Consequently, automatic
updating is not represented as complete: the Settings UI shows an honest **Not configured** release status, updater
artifacts remain disabled, and update distribution is blocked.

## Validation environment

| Item | Value |
| --- | --- |
| Operating system | Windows 11 Home, version 10.0.26200, build 26200 |
| Bun | 1.3.14 |
| Rust | rustc 1.97.0 (2d8144b78 2026-07-07) |
| Cargo | 1.97.0 (c980f4866 2026-06-30) |
| Desktop app version | 0.1.0 |
| Updater artifacts | `createUpdaterArtifacts: false` |

## Acceptance status

| Area | Status | Evidence |
| --- | --- | --- |
| Preference migration | Automated | Desktop preference/store tests cover defaults and migrations. |
| Simplified Chinese / English | Automated | Provider, route, and Settings tests cover immediate switching and persistence. |
| Liquid glass | Partial manual + automated | Windows 11 Mica selection and solid fallback are covered; iterative Windows 11 screenshots were reviewed. Windows 10 Acrylic still needs clean-VM confirmation. |
| Notifications | Automated | Permission, focus, category, privacy-safe content, and duplicate-suppression behavior are covered. |
| Context compression | Automated | API and Settings tests cover validation, persistence, and new-Session behavior. |
| User and Task memory | Automated | Storage, API, and UI tests cover cross-Session listing/search plus edit, delete, compact, and export. |
| Automatic updates | **Blocked / skipped** | Tasks 11 and 12 were skipped; no updater state machine, signed endpoint, or updater artifacts exist. |
| Placeholder cleanup | Complete | Implemented settings use real controls; the skipped updater uses a non-interactive release-gate status rather than a disabled fake control. |

## Accessibility and keyboard evidence

- Settings controls expose labels, error text, status text, and semantic regions in automated accessibility tests.
- The shared dialog test verifies that Escape closes a dialog and focus returns to its trigger.
- The updater release gate is a labelled region and cannot receive misleading control focus.

## Verification commands

| Command | Result |
| --- | --- |
| `bun script/generate.ts` | Passed; generated SDK output completed. The generator's unrelated whole-repository formatting noise was discarded. |
| `bun run --cwd packages/app test` | Passed: 73 files, 377 tests. jsdom emitted only its known `Window.scrollTo()` not-implemented notices. |
| `bun run --cwd packages/app typecheck` | Passed. |
| `bun run --cwd packages/app build` | Passed: Vite production build completed. |
| `bun run --cwd packages/jyycode typecheck` | Passed. |
| `bun run --cwd packages/sdk/js typecheck` | Passed. |
| `bun run --cwd packages/desktop typecheck` | Passed. |
| `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` | Passed: 15 tests; linker emitted one informational library-creation warning. |
| `git diff --check` | Passed. |

Automated validation is complete. Clean Windows 10/11 VM validation remains a release-time manual gate as recorded
below; this document deliberately does not treat the current Windows 11 development machine as the full matrix.

## Known limits and release gates

- Tasks 11 and 12 were intentionally skipped. Update code is incomplete, so update releases are blocked rather than
  merely awaiting configuration.
- No updater private key/password, embedded public key, signed HTTPS manifest endpoint, code-signing credential, or
  staged updater end-to-end test is present.
- This pass ran on Windows 11 only. Windows 10 Acrylic behavior and the complete clean-VM matrix remain release checks.
- The screenshots used during iterative UI review are user-provided development evidence, not clean-VM release
  certification.

## Updater gate conclusion

**Code not complete; release blocked.** Do not publish or advertise automatic updates until Tasks 11 and 12 (or an
approved replacement design) are implemented, security-reviewed, and validated against a signed staging endpoint.
