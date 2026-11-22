# vk-2997 Pi extension harness

Run at `4b4b7b8` on a clean tree. The commit adding this file changes nothing
else, so the code it describes is the code in the commit that contains it.

`npm run test` does not cover the Pi plugin. Its harnesses bundle the
extension with esbuild and drive it with a fake Pi API; none needs Pi or a
Runir service. Command:

```
zsh plugins/runir-pi/test/run.sh
```

**Exit 0. 82 PASS, 0 FAIL**: 75 from the existing OM-4, OM-5, OM-6 and store
harnesses, and 7 from `tenant-harness.mjs`:

- PASS tenant only in RUNIR_ENV_FILE: registers recall, capture and commands
- PASS tenant in neither place: no recall or capture, an off badge and a warning
- PASS tenant in neither place, print or JSON mode: the warning goes to stderr
- PASS tenant only in the default ~/Code/runir/.env: used without RUNIR_ENV_FILE
- PASS tenant only in RUNIR_ENV_FILE: runir_store sends it
- PASS tenant missing and env file absent: same off badge and warning
- PASS process env tenant wins over RUNIR_ENV_FILE

The tenant harness replaces `fetch` with a stub that records every request
and points `RUNIR_BASE` at a closed port, so no case reaches a real service.
The default-path case points `HOME` at a temporary directory holding
`Code/runir/.env`. The harness deletes its temporary files when it finishes.

| Case | Checks |
|---|---|
| Tenant only in the env file | `session_start`, `before_agent_start` and `agent_end` handlers, commands and tools are registered; first status `ᚱ ready`; no warning; the session-start request carries the file's tenant |
| No tenant, with a UI | Only a `session_start` handler; no commands or tools; status `ᚱ off: no RUNIR_USER_ID`; one warning naming `RUNIR_USER_ID` and `RUNIR_ENV_FILE` |
| No tenant, `hasUI: false` (print or JSON mode) | One `console.warn` (stderr) naming both; no status or notify calls; no request sent |
| Tenant only in the default path | Without `RUNIR_ENV_FILE`, the session-start request carries the tenant from `~/Code/runir/.env` |
| Tenant only in the env file, `runir_store` | The store request carries the file's tenant |
| No tenant, env file absent | Off badge and warning; no request sent |
| Tenant in env and file | `runir_store` sends the env tenant |

## Live smokes

Run by hand against a local service, with `RUNIR_USER_ID`, `RUNIR_API_KEY`
and `RUNIR_ENV_FILE` unset, so both came from the default env file:

- `om4-live-smoke.mjs`: exit 0. Health and auth ok, and it reported the env file's tenant.
- `om6-live-smoke.mjs` without `RUNIR_SMOKE_SEMIOTE_ID`: exits with "set RUNIR_SMOKE_SEMIOTE_ID …".
- `om6-live-smoke.mjs` with a memory id from that tenant: exit 0.

The tenant, key and memory id are the operator's and are not recorded here.
