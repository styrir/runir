# vk-2997 Pi extension harness

Run at `eb26eb1` on a clean tree. The commit adding this file changes nothing
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

Run by hand at the same tree against a local service. Each smoke first runs
the shared preflight (`test/live-smoke-config.mjs`), which resolves
`RUNIR_USER_ID` and `RUNIR_API_KEY` from the environment, then
`RUNIR_ENV_FILE`, and prints where each came from (never the values).

Unconfigured, with `RUNIR_USER_ID` and `RUNIR_API_KEY` unset and
`RUNIR_ENV_FILE` pointing at a temporary file holding only one of them:

| Smoke | Env file has only the tenant | Env file has only the key |
|---|---|---|
| OM-4 | exit 2: `RUNIR_API_KEY not set; checked the environment and RUNIR_ENV_FILE (…)` | exit 2: `RUNIR_USER_ID not set; …` |
| OM-5 | exit 2: `RUNIR_API_KEY not set; …` | exit 2: `RUNIR_USER_ID not set; …` |
| OM-6 | exit 2: `RUNIR_API_KEY not set; …` | exit 2: `RUNIR_USER_ID not set; …` |

Configured, OM-6 with `RUNIR_SMOKE_SEMIOTE_ID` set to a memory id from the
tenant:

| Smoke | From the default env file (nothing in the environment) | From environment overrides, `RUNIR_ENV_FILE` pointing nowhere |
|---|---|---|
| OM-4 | exit 0; preflight: both from RUNIR_ENV_FILE; `auth: ok`, `errors: 0` | exit 0; preflight: both from environment; `auth: ok`, `errors: 0` |
| OM-5 | exit 0 in 4 s; one compact call carrying a compaction projection | exit 0 |
| OM-6 | exit 0; the lookup returns; the all-zero sentinel id reports not-found | exit 0 |

OM-5 previously completed its fake compaction only after `agent_end` had
returned, so the forced band waited for the extension's two-minute watchdog.
It now completes on the next tick.

The tenant, key and memory id are the operator's and are not recorded here.
