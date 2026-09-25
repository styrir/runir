# Slice 3 operator scrub

The CLI defaults to read-only `inventory`. It emits only row counts, detector-kind
row counts, and the inventory digest. It requires an explicit vault root so the
inventory and verification include existing exports. The vault may be the owner's
entire Obsidian vault. Inventory, apply, and verify process only exporter-written
`99 Meta` JSON files or Markdown with the exporter's leading frontmatter signature
and an ID found in the corresponding database table. Other files are reported
only as `owner_files_skipped`; their content is never scanned or changed. The
frontmatter check reads at most the first 4 KiB. Apply prints owned/skipped counts
before changes and refuses an empty owned set unless `--allow-empty-vault` is
explicitly supplied. The digest is bound to
the selected namespace/database and scanned rows/files. Run `apply` within
one hour of inventory. Keep the inventory file and checkpoint in the ignored
`.styrir` workspace. Do not share the DB export, vault archive, or old WAL.

Set `SURREAL_URL`, `SURREAL_USER`, `SURREAL_PASS`, `SURREAL_NS`, `SURREAL_DB`,
and `RUNIR_SOURCE_HMAC_KEY` in the operator's environment. Set `RUNIR_VAULT`
to the absolute path of the managed vault, and `RUNIR_BACKUP` and
`RUNIR_VAULT_BACKUP` to protected absolute paths outside the repository.
Load the service's `EMBEDDINGS_*` environment before `apply` and `verify` so
recomputed vectors use the production model. Do not pass the password or HMAC
key on the command line.

```sh
mkdir -p .styrir/pipelines/source-layer
umask 077
surreal export --endpoint "$SURREAL_URL" --namespace "$SURREAL_NS" --database "$SURREAL_DB" "$RUNIR_BACKUP"
tar -cf "$RUNIR_VAULT_BACKUP" -C "$RUNIR_VAULT" .
chmod 600 "$RUNIR_BACKUP" "$RUNIR_VAULT_BACKUP"
npx tsx scripts/source-layer/cli.ts inventory --vault "$RUNIR_VAULT"
npx tsx scripts/source-layer/cli.ts apply --confirm --backup "$RUNIR_BACKUP" --vault-backup "$RUNIR_VAULT_BACKUP" --vault "$RUNIR_VAULT"
npx tsx scripts/source-layer/cli.ts verify --vault "$RUNIR_VAULT"
```

The tar backup deliberately contains the **whole vault**, including personal
notes. It can therefore be large; allow enough private storage for the full
archive before applying the scrub.

`apply` refuses a missing, group/world-readable, or repository-local backup,
missing confirmation, stale inventory,
different DB target, or missing HMAC key. It uses one-row transactions and
checkpoints after verifying each row. Re-run the same `apply` command after an
interruption; it resumes from the checkpoint. Successful `verify` requires
zero remaining raw-source fields, old turn text, and detector changes in all
named fields and vault files. Keep recall off until the separate privacy gate
and operator review pass. The old data directory, WAL, snapshots, and backups
remain sensitive after live-row verification. Destroy the export only under the
separate incident-retention step; it must not be restored to undo a scrub.
