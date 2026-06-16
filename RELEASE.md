# Release

This repository publishes the user-facing npm package `jyycode-ai`.

## One-time setup

1. Create an npm automation token with publish permission.
2. Add it to the GitHub repository secrets as `NPM_TOKEN`.
3. Make sure the npm package name `jyycode-ai` is owned by the publishing npm account.

## Publish

1. Open GitHub Actions.
2. Run the `release-cli-npm` workflow.
3. Enter a new semver version, for example `1.15.11`.
4. Keep `npm_tag` as `latest` for normal releases.

The workflow creates a GitHub Release, builds platform binaries, uploads release assets, publishes the lightweight npm wrapper, and then makes the GitHub Release public.

After the workflow succeeds, users can install and run:

```bash
npm install -g jyycode-ai
jyy
```

The `jyy` command runs in the terminal's current working directory.
