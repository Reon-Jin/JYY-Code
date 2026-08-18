# Security Policy

JYY-Code takes the security of the software and its users seriously. This policy
describes which versions receive security updates and how to report a vulnerability.

## Supported Versions

Security updates are released for the following version lines. Versions are published
both as [GitHub Releases](https://github.com/Reon-Jin/JYY-Code/releases) (git tags
`vX.Y.Z`) and as the npm package [`jyycode-ai`](https://www.npmjs.com/package/jyycode-ai);
both use the same version numbers.

| Version | Supported          |
| ------- | ------------------ |
| 2.1.x   | :white_check_mark: |
| 2.0.x   | :white_check_mark: |
| 1.x     | :x:                |

- **2.1.x** — the current release line. Receives full security support, including fixes
  and backports.
- **2.0.x** — the previous release line. Receives security fixes while 2.1.x is the
  current line, to give users time to upgrade.
- **1.x and earlier** — end of life. No security updates are provided. Upgrade to a
  supported version as soon as possible.

If you are unsure which version you run, check the release tag of your build, the
version printed by `jyycode --version`, or the version listed on the Releases page.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Public issues are
searchable, and details in them can put users at risk. Per the project's
[privacy policy](PRIVACY.md), never include passwords, API keys, access tokens, or other
sensitive data in public issues either.

### How to report

Use GitHub's **private vulnerability reporting** on this repository:

1. Go to <https://github.com/Reon-Jin/JYY-Code/security/advisories> (or open the
   repository's **Security** tab and click **Report a vulnerability**).
2. Fill in the advisory form with as much of the following as you can:

   - The JYY-Code version and platform (OS, terminal, desktop or CLI, architecture).
   - A clear description of the vulnerability and its impact.
   - Steps to reproduce, or a minimal proof of concept.
   - Any affected configuration, plugins, or integrations.
   - Whether the issue is already public or known to others.

3. Submit the report.

### What to expect

- **Acknowledgment.** You should receive an acknowledgment within **72 hours** of
  submitting your report.
- **Updates.** You can expect a status update at least every **7 days** until the issue
  is resolved. Updates will note progress, expected timelines, and any requests for
  additional information.
- **Accepted reports.** If the vulnerability is confirmed, we will develop a fix, backport
  it to supported versions, and release it. We will work with you on coordinated
  disclosure and credit you for the finding unless you prefer to remain anonymous.
- **Declined reports.** If the report is not accepted (for example, it is a
  configuration issue, a non-security bug, or already known and handled), we will explain
  why and suggest the appropriate next step, which may be filing a normal issue.

### If private reporting is unavailable

If you are unable to use GitHub's private reporting form for any reason, please reach out
through the [Discord community](https://discord.gg/jyycode) and ask to be connected to a
maintainer privately. Do not post vulnerability details in public channels.

### Responsible disclosure

Please give us reasonable time to fix and release a patch before disclosing the
vulnerability publicly. We aim to publish security fixes promptly and will include
details in the corresponding release notes.

### Scope

The security policy covers the JYY-Code source code in this repository and the
artifacts published through official release channels. Vulnerabilities in AI providers,
MCP servers, or other third-party services you connect to should be reported to those
services directly.
