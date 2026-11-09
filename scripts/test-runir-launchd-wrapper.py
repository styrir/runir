#!/usr/bin/env python3
"""Offline launcher checks; all executable seams and dotenv data are temporary."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time


SOURCE = Path(__file__).with_name("runir-launchd-wrapper.sh").read_text()
PYTHON = str(Path(sys.executable).resolve())
NANO = "fake-nanogpt-key-000000000"
HMAC = "fake-source-hmac-000000000"
TOKEN = "fake-machine-token-00000000"
CLIENT_ID = "fake-machine-client-0000000"
CLIENT_SECRET = "fake-machine-secret-0000000"


def executable(path, body):
    path.write_text(f"#!{PYTHON}\n" + body)
    path.chmod(0o755)
    return str(path)


def run():
    with tempfile.TemporaryDirectory(prefix="runir-launcher-check-") as directory:
        root = Path(directory)
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": directory,
            "RUNIR_ROOT": directory,
            "RUNIR_ENV_FILE": str(root / "override.env"),
            "CALLS": str(root / "calls.jsonl"),
            "INFISICAL_TOKEN": "inherited-token-must-not-be-used",
            "INFISICAL_CLIENT_ID": "inherited-client-must-not-leak",
            "INFISICAL_CLIENT_SECRET": "inherited-secret-must-not-leak",
            "OPENROUTER_API_KEY": "inherited-stale-key",
            "RUNIR_SOURCE_HMAC_KEY": "inherited-stale-hmac",
            "DOTENV_CONFIG_OVERRIDE": "true",
        }
        (root / "override.env").write_text(
            "OPENROUTER_API_KEY=stale-dotenv-provider-key\n"
            "RUNIR_SOURCE_HMAC_KEY=stale-dotenv-hmac\n"
            "RUNIR_LLM_BASE_URL=https://stale.invalid\n"
            "EXTRACT_MODEL=stale-model\n"
            "RERANKER_PROVIDER=llm\n"
            "RUNIR_EXTRACTOR_MODEL=vertex/stale\n"
            "RUNIR_ENTITY_MODEL=vertex/stale\n"
            "RUNIR_SEGMENT_MODEL=vertex/stale\n"
            "RUNIR_CONTINUITY_MODEL=vertex/stale\n"
            "FAKE_DOTENV_MARKER=override-file-loaded\n"
        )
        (root / ".env").write_text("FAKE_DOTENV_MARKER=wrong-file\n")
        infisical = executable(root / "infisical", f"""
import json, os, sys
a = sys.argv[1:]
with open(os.environ["CALLS"], "a") as log:
    log.write(json.dumps(a) + "\\n")
assert "INFISICAL_TOKEN" not in os.environ
assert "INFISICAL_CLIENT_ID" not in os.environ
assert "INFISICAL_CLIENT_SECRET" not in os.environ
mode = os.environ.get("FAKE_MODE", "")
def option(name):
    return a[a.index(name) + 1]
if a[0] == "login":
    assert option("--method") == "universal-auth"
    assert option("--client-id") == {CLIENT_ID!r}
    assert option("--client-secret") == {CLIENT_SECRET!r}
    value, fail = {TOKEN!r}, mode in ("tokenfail", "bothfail")
elif a[:3] == ["secrets", "get", "RUNIR_SOURCE_HMAC_KEY"]:
    assert option("--projectId") == "2588c473-4c4c-4b5a-b0f5-e261184b6b53"
    assert option("--env") == "dev" and option("--path") == "/"
    assert option("--token") == {TOKEN!r}
    value, fail = {HMAC!r}, mode == "hmacfail"
else:
    assert a[:3] == ["secrets", "get", "nanogpt"]
    assert option("--projectId") == "402716ac-2805-4864-b3ce-e11b838f78b3"
    assert option("--env") == "prod" and option("--path") == "/providers"
    assert "--token" not in a
    value, fail = {NANO!r}, mode in ("nanofail", "bothfail")
# Valid-looking token lines must not make multiline stdout acceptable.
if (mode == "nanomultiline" and a[:3] == ["secrets", "get", "nanogpt"]) or (mode == "tokenmultiline" and a[0] == "login"):
    print("fake-note")
    print(value)
    raise SystemExit(0)
# Partial stdout from a failed command must never become an injected credential.
print(value)
if fail:
    print("fake-private-error", file=sys.stderr)
sys.exit(7 if fail else 0)
""")
        security = executable(root / "security", f"""
import os, sys
assert sys.argv[1:3] == ["find-generic-password", "-s"]
assert sys.argv[-1] == "-w"
if os.environ.get("FAKE_MODE") == "keychainfail":
    raise SystemExit(7)
service = sys.argv[3]
assert service in ("runir.infisical.client-id", "runir.infisical.client-secret")
print({CLIENT_ID!r} if service.endswith("client-id") else {CLIENT_SECRET!r})
""")
        env["RUNIR_NODE_BIN"] = executable(root / "node", """
import json, os, sys
assert sys.argv[1:] == ["--import", "tsx/esm", "--import", "dotenv/config", "index.ts"]
assert "DOTENV_CONFIG_OVERRIDE" not in os.environ
# Emulate dotenv's default: existing exported values, even "", win.
with open(os.environ["DOTENV_CONFIG_PATH"]) as dotenv:
    for line in dotenv:
        key, value = line.strip().split("=", 1)
        os.environ.setdefault(key, value)
print(json.dumps(dict(os.environ)))
""")
        copied = SOURCE.replace("/opt/homebrew/bin/python3", shlex.quote(PYTHON))
        copied = copied.replace("/opt/homebrew/bin/infisical", infisical)
        copied = copied.replace("/usr/bin/security", shlex.quote(security))
        wrapper = root / "wrapper.sh"
        wrapper.write_text(copied)
        models = {
            "EXTRACT_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_EXTRACTOR_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_ENTITY_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_SEGMENT_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_CONTINUITY_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_THINK_MODEL": "openai/gpt-5.6-luna",
            "RUNIR_STALENESS_MODEL": "openai/gpt-5.4-mini",
            "RUNIR_SUPERSEDE_JUDGE_MODEL": "openai/gpt-5.4-mini",
            "ENRICH_MODEL": "openai/gpt-5.4-mini",
            "SYNTHESIS_MODEL": "openai/gpt-5.4-mini",
        }
        for mode, nano, hmac in [
            ("success", NANO, HMAC),
            ("tokenfail", NANO, ""),
            ("nanofail", "", HMAC),
            ("hmacfail", NANO, ""),
            ("bothfail", "", ""),
            ("keychainfail", NANO, ""),
            ("nanomultiline", "", HMAC),
            ("tokenmultiline", NANO, ""),
        ]:
            Path(env["CALLS"]).write_text("")
            result = subprocess.run(
                ["/bin/zsh", str(wrapper)], env={**env, "FAKE_MODE": mode},
                capture_output=True, text=True, timeout=10,
            )
            assert result.returncode == 0, (mode, result.stderr)
            child = json.loads(result.stdout)
            assert child["OPENROUTER_API_KEY"] == nano, mode
            assert child["RUNIR_SOURCE_HMAC_KEY"] == hmac, mode
            assert child["DOTENV_CONFIG_PATH"] == env["RUNIR_ENV_FILE"]
            assert child["FAKE_DOTENV_MARKER"] == "override-file-loaded"
            assert child["RUNIR_LLM_BASE_URL"] == "https://api.nano-gpt.com/api/v1"
            assert child["RERANKER_PROVIDER"] == "local"
            assert all(child[key] == value for key, value in models.items())
            for key in (
                "INFISICAL_TOKEN", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET",
                "RUNIR_INFISICAL_CLIENT_ID", "RUNIR_INFISICAL_CLIENT_SECRET",
                "client_id", "client_secret", "token", "key",
            ):
                assert key not in child, (mode, key)
            for secret in (NANO, HMAC, TOKEN, CLIENT_ID, CLIENT_SECRET, "fake-private-error"):
                assert secret not in result.stderr, mode
            calls = [json.loads(line) for line in Path(env["CALLS"]).read_text().splitlines()]
            nano_calls = [a for a in calls if a[:3] == ["secrets", "get", "nanogpt"]]
            assert len(nano_calls) == 1 and "--token" not in nano_calls[0], mode
            if mode in ("tokenfail", "bothfail", "keychainfail", "tokenmultiline"):
                assert not any("RUNIR_SOURCE_HMAC_KEY" in a for a in calls), mode

        # Also exercise explicit fake machine-identity overrides and their removal.
        result = subprocess.run(
            ["/bin/zsh", str(wrapper)],
            env={**env, "FAKE_MODE": "keychainfail",
                 "RUNIR_INFISICAL_CLIENT_ID": CLIENT_ID,
                 "RUNIR_INFISICAL_CLIENT_SECRET": CLIENT_SECRET},
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0 and not result.stderr
        child = json.loads(result.stdout)
        assert child["RUNIR_SOURCE_HMAC_KEY"] == HMAC
        assert "RUNIR_INFISICAL_CLIENT_ID" not in child
        assert "RUNIR_INFISICAL_CLIENT_SECRET" not in child

        start = copied.index("with_timeout() {")
        function = copied[start:copied.index("\n}\n", start) + 3]

        def invoke(*args, function_text=function, extra_env=None):
            # Command substitution is the launcher's actual acquisition shape.
            script = function_text + '''
value="$(with_timeout "$@")"
rc=$?
printf '%s' "$value"
exit "$rc"
'''
            return subprocess.run(
                ["/bin/zsh", "-c", script, "check", *args],
                env={**env, **(extra_env or {})}, cwd=root,
                capture_output=True, timeout=30,
            )

        def check(expected, *args, **kwargs):
            result = invoke(*args, **kwargs)
            assert (result.returncode, result.stdout, result.stderr) == expected

        check((0, b"fake-token", b""), PYTHON, "-c", 'print("fake-token")')
        check((7, b"", b""), PYTHON, "-c", "raise SystemExit(7)")
        check((143, b"", b""), PYTHON, "-c",
              "import os, signal; os.kill(os.getpid(), signal.SIGTERM)")
        check((127, b"", b""), str(root / "missing-command"))
        check((126, b"", b""), "/dev/null")
        for helper, expected in [(str(root / "missing-python"), 127), ("/dev/null", 126)]:
            result = invoke(
                PYTHON, "-c", 'print("unexpected fallback")',
                function_text=function.replace(shlex.quote(PYTHON), shlex.quote(helper)),
            )
            assert result.returncode == expected and not result.stdout
            assert b"Traceback" not in result.stderr

        (root / "subprocess.py").write_text("raise SystemExit(99)\n")
        check((0, b"isolated", b""), PYTHON, "-c", 'print("isolated")',
              extra_env={"PYTHONPATH": directory})
        assert shlex.quote(PYTHON) + " -I -c" in function
        started = time.monotonic()
        result = invoke(
            PYTHON, "-c",
            "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print(os.getpid(), flush=True); time.sleep(60)",
        )
        assert (result.returncode, result.stderr) == (124, b"")
        assert 19 <= time.monotonic() - started < 30
        try:
            os.kill(int(result.stdout), 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError("timed-out direct child survived")
    print("PASS: offline launcher credentials, routing, isolation, failures and deadline")


if __name__ == "__main__":
    run()
