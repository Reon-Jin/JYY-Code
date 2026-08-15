# Credential reference migration

Provider options are being changed from inline secret values to durable,
value-free `CredentialRef` objects.

## Release phases

| Release | Read behavior | Write behavior | Gate |
| --- | --- | --- | --- |
| N | Accept references and decode inline values for compatibility | Automatically save inline values to the auth store, warn, and persist the reference | Migration count, auth-store write success, and no secret in serialized request/replay data |
| N+1 | Resolve only through `Credential.Service` at request time | Write references; do not create new inline config | Legacy inline-write counter is zero and compatibility reads are understood |
| N+2 | Reject inline values with a remediation message | References only | Zero legacy reads for the observation window; then schedule legacy field/table removal |

## Backup, dry run, validation, and rollback

Before migration, stop JYY-Code and back up the config, auth store, database
plus WAL/SHM files, and blob root as one versioned set. A dry run must list
provider IDs, credential kinds, and whether a reference already exists; it must
not print key material.

Apply the migration idempotently: validate the inline value, write the auth
record, derive the reference, and persist the provider config without the
inline field. Then validate that every configured provider either has a valid
reference or an explicit non-secret public configuration, and that request
envelopes, session events, SDK output, and telemetry contain no secret value.

If any validation fails, keep the migrated copy for diagnosis and restore the
matched pre-migration copy or run the prior binary. Do not reconstruct secrets
from events or rewrite historical events. After the release gate, rotate
credentials normally through the auth service and remove the legacy decoder in
the planned N+2 cleanup.
