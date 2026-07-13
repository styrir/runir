---
title: Styrir product-repo export manifest
type: release
date: 2026-07-13
status: DRAFT
---

# Styrir product-repo export (forge → clean tree)

This is the **forge-side** playbook for graduating Rúnir into a clean Styrir brand repo.

| Repo | Role |
|---|---|
| **This forge** (`AlphaComposite/runir` or successor) | Archive / laboratory: full history, beads, pipeline, harness, probes |
| **Styrir product repo** (TBD remote) | Living product: allowlisted files only; all post-cut development |

**Do not hand-delete folders in the forge.** Export an allowlisted tree into a staging directory, verify, then `git init`.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/export-styrir-tree.sh <dest>` | Copy allowlisted paths into `<dest>` and apply product overlays |
| `scripts/verify-styrir-tree.sh <dest>` | Stranger-style install + typecheck (+ optional test/lint/hooks) |

Allowlist: `docs/release/styrir-export-allowlist.txt`  
Hard denylist (export aborts if matched): `docs/release/styrir-export-denylist.txt`  
Product overlays (written into dest): `docs/release/styrir-product-overlay/`

## Recommended sequence

```bash
# 1) Export from a known cut (prefer tag)
git checkout v1.0.0   # or main after release commits

# 2) Staging tree (outside forge)
DEST=/tmp/styrir-runir-staging
rm -rf "$DEST"
./scripts/export-styrir-tree.sh "$DEST"

# 3) Verify before any git history
./scripts/verify-styrir-tree.sh "$DEST"
# optional fuller gate:
# VERIFY_LINT=1 VERIFY_TEST=1 VERIFY_HOOKS=1 ./scripts/verify-styrir-tree.sh "$DEST"

# 4) Only after green: create product history
cd "$DEST"
git init -b main
git add .
git commit -m "Initial import: Rúnir 1.0.0 (filtered export from forge tag v1.0.0)"
git tag -a v1.0.0 -m "Rúnir 1.0.0"

# 5) Push to empty Styrir remote (create repo first)
# git remote add origin git@github.com:Styrir/runir.git
# git push -u origin main
# git push origin v1.0.0

# 6) Mothball forge (manual): archive on GitHub + README redirect
```

## What graduates (summary)

**In:** `src/`, `cli/`, supported plugins (`runir-claudecode`, `runir-codex`), product `test/` + product `src` tests, schemas/fixtures, lean docs (scope/ops), minimal install/hook scripts, CI workflow, root package metadata.

**Out:** `.pipeline/`, `.beads/`, agent tooling dirs, full `harness/`, measurement scripts (`g004/`, `h435/`, probes), handoffs/analysis/plans, hermes/openclaw experimental surfaces, local secrets.

See allowlist file for the authoritative path list.

## Product overlays

Export **rewrites** a few files in the destination so the lean tree is self-consistent:

| File | Why |
|---|---|
| `tsconfig.json` | Do not typecheck the whole forge `scripts/**` tree |
| `vitest.config.ts` | Product unit tests only; exclude lab-coupled suites |
| `package.json` `scripts` | Drop corpus/harness/pn1l/h435 lab npm scripts |
| `.gitignore` | Product-oriented ignores (no beads/pipeline/harness traces) |
| `STYRIR_EXPORT.md` | Provenance stamp (source tag/sha, export time) |

The forge copies of those files are **not** permanently altered; only the staging tree is.

## Verify levels

| Env | Default | What runs |
|---|---|---|
| (always) | on | `npm ci`, `npm run typecheck` |
| `VERIFY_LINT=1` | off | `npm run lint` |
| `VERIFY_TEST=1` | off | `npm run test:ci` (product vitest include; lab-coupled suites excluded via overlay) |
| `VERIFY_HOOKS=1` | off | claudecode + codex hook contract scripts |
| `VERIFY_BOOT=1` | off | brief `/health` with `SURREAL_*` (see script) |

## Mothball checklist (after Styrir is SoT)

- [ ] Styrir remote green on CI  
- [ ] Local clones / launchd / agents re-pointed  
- [ ] Forge README banner: active development URL  
- [ ] GitHub **Archive repository** on forge (or org write lockdown)  
- [ ] No new product commits on forge  

## Non-goals of this export

- Preserving forge git history in Styrir (use `git-filter-repo` only if that becomes a requirement later)  
- Shipping competitive harness / MemPalace / LoCoMo lab  
- Shipping beads / DOX / pipeline operating system  
