# vk-2997 Pi extension harness

Run at `c66cc49` on a clean tree. The commit adding this file changes nothing
else, so the code it describes is the code in the commit that contains it.

`npm run test` does not cover the Pi plugin. Its harnesses bundle the
extension with esbuild and drive it with a fake Pi API; none needs Pi or a
Runir service. Command:

```
zsh plugins/runir-pi/test/run.sh
```

**Exit 0. 79 PASS, 0 FAIL**: 75 from the existing OM-4, OM-5, OM-6 and store
harnesses, and 4 from the new `tenant-harness.mjs`:

- PASS tenant only in RUNIR_ENV_FILE: registers recall, capture and commands
- PASS tenant in neither place: no recall or capture, an off badge and a warning
- PASS tenant missing and env file absent: same off badge and warning
- PASS process env tenant wins over RUNIR_ENV_FILE

The tenant harness replaces `fetch` with a stub that records every request,
and points `RUNIR_BASE` at a closed port, so no case reaches a real service.
What each case checks:

| Case | Checks |
|---|---|
| Tenant only in the env file | `session_start`, `before_agent_start` and `agent_end` handlers, commands and tools are registered; the first status is `ᚱ ready`; no warning; the session-start request carries the file's tenant |
| Tenant in neither place | Only a `session_start` handler; no commands or tools; status `ᚱ off: no RUNIR_USER_ID`; one warning naming `RUNIR_USER_ID` and `RUNIR_ENV_FILE` |
| No tenant, env file absent | Same badge and warning; no request sent |
| Tenant in env and file | `runir_store` sends the env tenant |

Before this change, the same harness against `eadef2a` passes the 75 existing
cases. The tenant harness did not exist there; its first two cases describe
behavior that commit lacked (it registered nothing without `RUNIR_USER_ID` in
the process env and ignored the env file's value).
