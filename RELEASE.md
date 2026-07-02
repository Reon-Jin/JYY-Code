# Release

This repository publishes the user-facing npm package `jyycode-ai`.

## One-time setup

1. Create an npm automation token with publish permission.
2. Add it to the GitHub repository secrets as `NPM_TOKEN`.
3. Make sure the npm package name `jyycode-ai` is owned by the publishing npm account.

## Publish

1. Stop all JYYCode processes that may write SQLite.
2. Confirm the selected installation channel and active database with `jyycode db status`.
3. Back up the active `.db` file together with its `-wal` and `-shm` companions.
4. Copy the database backup to a disposable directory. Run the release candidate against the copy, then run
   `PRAGMA integrity_check` and compare project/session/message/part counts before and after migration.
5. Build the native target and require both smoke checks to pass:

   ```bash
   bun run --cwd packages/jyycode build --single --skip-install
   bun run packages/jyycode/script/session-persistence-smoke.ts
   ```

   The persistence smoke must print `session persisted`.

6. Open GitHub Actions and run the `release-cli-npm` workflow.
7. Enter a new semver version, for example `1.15.11`.
8. Keep `npm_tag` as `latest` for normal releases.

The workflow creates a GitHub Release, builds platform binaries, uploads release assets, publishes the lightweight npm wrapper, and then makes the GitHub Release public.

After the workflow succeeds, users can install and run:

```bash
npm install -g jyycode-ai
jyy
```

The `jyy` command runs in the terminal's current working directory.

## Database rollback

Do not run an older binary against a database already migrated by an unverified release candidate. If migration,
integrity checking, or persistence smoke fails, stop the candidate, retain the failed copy for diagnosis, restore the
original database backup and its WAL/SHM companions, and restart the previously verified binary with the original
channel policy. `JYYCODE_DISABLE_CHANNEL_DB=1` is an expert override and must not be used to mix binaries with
incompatible schemas.
