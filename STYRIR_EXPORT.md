# Styrir export provenance

| Field | Value |
|---|---|
| exported_at_utc | 2026-07-13T14:15:51Z |
| forge_path | /tmp/runir-v1-export-xaH5lO/src |
| forge_branch | HEAD |
| forge_sha | 85b9796c4613e2d724c88da7febb7227c3b92e4e |
| forge_tag | v1.0.0 |
| allowlist | docs/release/styrir-export-allowlist.txt |
| denylist | docs/release/styrir-export-denylist.txt |

This tree is a **filtered product export**. Laboratory history stays in the forge archive.
Do not copy `.pipeline/`, `.beads/`, or measurement harnesses into this repository.

Next: `../scripts/verify-styrir-tree.sh` from forge, or:
```bash
cd styrir-runir-product   # this tree
npm ci && npm run typecheck
```
