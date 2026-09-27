# Slice 3 operator scrub

The Slice 5 synthetic measurement harness runs with `npm run measure:source-layer` against the local SurrealDB (`SOURCE_LAYER_MEASURE_SURREAL_URL` defaults to `http://127.0.0.1:8000`). It creates and removes a random `slice4` namespace, uses temporary spool and vault directories, runs source recall in `off`, `shadow`, and `on` modes only inside that namespace, and writes count-only, mode-0600 results under `.styrir/analysis/source-layer/<runId>/`; a failed gate exits non-zero. It does not change production flags or data. `slice4Complete` covers the Slice 4 storage, privacy, and replay gates; `slice5Complete` and `releaseReady` require the Slice 5 gates and every recorded gate to pass. These booleans describe the isolated synthetic run, not authorization for a production flag change. Paraphrase retrieval is reported but is not a gate.

`RUNIR_SOURCE_RECALL` defaults to `off`; unknown values are treated as `off`. In `on`, selected active facts may carry up to three verified, redacted source excerpts in the recall response's `sourceExcerpts` field and inside the existing `prependContext` wrapper. Each excerpt is at most 120 estimated tokens, with a 360-token source cap. A request `budgetTokens` also limits the additional block to the room left after wrapped facts. Linked exact-QA facts can receive a selection boost under `on`, so selection and order can change. In `shadow`, the response and retrieval trace contain no excerpt fields or text. Counts, hashed IDs, ranks, lengths, latency, and failures are available from `GET /admin/source-recall-metrics`, which requires `RUNIR_API_KEY` even when other admin routes run without it. `/think` disables excerpts.

## Turn-by-turn recall release check

Run `npx tsx scripts/turn-by-turn-replay-harness.ts --source-recall=all` against a local SurrealDB. The harness replays synthetic sessions through isolated services with recall before every turn; `all` compares off, production-like shadow, and on, then repeats on to measure noise. Use `--source-recall=off|shadow|on|both|all` for a narrower run. It writes a synthetic HTML report and JSON under `.styrir/analysis/replay-harness/<runId>/` plus `latest.html`. This is the release check for any feature that changes recall output. Source storage is on in every mode. Fixture facts exercise capture without running the production extractor; session opener, compaction, and `/think` do not attach excerpts.

`clear-verified-spans.ts` is a separate operator tool. It defaults to count-only dry run and clears `payload.rawSpan`/`payload.rawSpans` only when the selected fact's primary linked turn passes the same active-state, boundary, fingerprint, and reassembled-content HMAC checks used at recall. Set the database target and HMAC key in the environment. Apply requires `--apply --i-have-owner-approval`; a `main` namespace or database refuses even dry run. The Slice 5 build does not run this tool on production.

The source writer checks all three stored fingerprint predicates once per writing
database client and latches the configured fingerprint in memory. Every later
source write compares its fingerprint to that latch. Key rotation (Rúnir-277.8)
or a database restore requires a service restart before source writes resume.
The out-of-process scrub and other external writers must not run while the
service writes. The spool joins each flush into one write and calls
`FileHandle.sync()` before acknowledging captures or forget tombstones; drain
persists one newline-framed `done` record per turn, with the records for a
window written and synced together. The measurement report includes an
isolated, stopped-drain paired capture gate and an informational run with the
production drain active, plus sync and fingerprint-scan counts per request.

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
