# Rúnir Evaluation Review Studio

Review Studio is a local evidence light table for model-benchmark artifacts.
The default launch is credential-free and file-only. Sensitive trace review is
an explicit, server-side loopback proxy mode; it is never enabled implicitly.

For the complete runner-to-review workflow, custom-model setup, and the recorded
Gemini 3.1 selection rationale, see
[`docs/model-benchmark-guide.md`](../../docs/model-benchmark-guide.md).

## Launch

Run from the repository root and provide one or more explicit artifact roots:

```bash
npm run review-studio -- --root tools/review-studio/fixtures --port 7711
```

Then open [http://127.0.0.1:7711](http://127.0.0.1:7711). The scanner accepts
paired `<name>.manifest.json` and `<name>.jsonl` bundles beneath the roots and
keeps only an in-memory projection. It never scans an implicit home directory,
opens an arbitrary browser path, or writes a catalog.

The checked-in fixture root contains two compatible, hash-stamped synthetic
runs. They are enough for the owner smoke: open Compare, select the two runs,
load the comparison, click an amber/teal dumbbell or heatmap cell, open exact
raw evidence, then use Print or Export JSON. No network call or paid model
execution is involved.

## Deterministic trace visual smoke

The checked-in stub is test-only, in-memory, loopback-only, and contains no
product data or real credentials. Run these as two separate processes:

Terminal A — test-only Rúnir stub:

```bash
npm run review-studio:stub -- --port 7720
```

Terminal B — Review Studio with explicit trace mode:

```bash
RUNIR_USER_ID=review-studio-smoke RUNIR_API_KEY=review-studio-test-key RUNIR_BASE_URL=http://127.0.0.1:7720/ npm run review-studio -- --root tools/review-studio/fixtures --port 7712 --trace
```

Open [http://127.0.0.1:7712](http://127.0.0.1:7712), choose Recall Receipts,
then select `trace-smoke-1`, open `memory-smoke-1` lineage, and choose a
rating. The stub supports the full list → detail → lineage → rating path and
mutates only its in-memory copy. The `review-studio-test-key` value is a
fixture-only bearer used by the stub; it is not a Rúnir credential.

## Repeatable tests

The root Vitest profile intentionally excludes `tools/**`; use the explicit
tool profile:

```bash
npm run review-studio:test
```

That command expands to:

```bash
vitest run --config tools/review-studio/vitest.config.ts
```

It covers catalog rebuilds, malformed/oversized input, traversal and symlink
boundaries, duplicate IDs, API authorization and evidence routes, export
denylisting, and the dependency boundary. TypeScript coverage includes the
tool through the root `typecheck` script.

## Slice boundary

The companion serves Runs, Compare, and Case Detail in file-only mode. Explicit
trace mode additionally provides the bounded Recall Receipts and Memory
Lineage review surfaces, plus the existing narrow trace rating write. It does
not provide benchmark scheduling, paid execution, a new trace table, reverse
trace lookup, or runtime policy mutation.

`security/index.ts` freezes these integration rules for the later slices:

- the companion binds only to the exact IPv4 loopback address `127.0.0.1`;
- each launch gets independent 32-byte random launch and mutation-CSRF proofs;
- proofs are rendered only as bootstrap metadata and are accepted only in
  `X-Runir-Launch-Token` / `X-Runir-CSRF-Token` headers;
- API requests require the exact canonical `Host` and `Origin`, reject
  cross-site Fetch Metadata, and do not participate in CORS;
- bootstrap responses use same-origin CSP, no-store, and browser hardening
  headers;
- the mutation proof is separate from launch authorization;
- launch/CSRF proofs and backend bearer values are redacted from logs and
  exports, and the security boundary has no browser-storage helper;
- the backend seam accepts only an explicit fixed loopback Rúnir base URL and
  explicit user ID, constructs relative endpoint requests, and owns
  `RUNIR_API_KEY` server-side;
- a browser-supplied upstream URL, path traversal, credential override, or
  secret-bearing query key is rejected.

The later trace proxy must call `authorizeApiRequest` before every companion
API route, call `responseHeaders` on responses, use `ConfiguredRunirBackend`
for Rúnir requests, and pass log/export payloads through the corresponding
redaction method. It must never serialize or forward the backend request
object to the browser.
