"""Load hyphenated hooks/runir-grok.py via importlib for unit tests."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HOOK_PATH = PLUGIN_ROOT / "hooks" / "runir-grok.py"


def load_hook_module():
    name = "runir_grok_hook_under_test"
    # Fresh load per session is fine; allow re-import in long pytest runs.
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HOOK_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {HOOK_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_script_module(script_name: str, module_name: str | None = None):
    """Load a scripts/*.py module by filename (e.g. runir_inspect.py)."""
    path = PLUGIN_ROOT / "scripts" / script_name
    name = module_name or f"runir_grok_{path.stem}_under_test"
    # Always reload so edits during a test session are visible.
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hook(tmp_path, monkeypatch):
    mod = load_hook_module()
    state_dir = tmp_path / "state" / "runir"
    state_dir.mkdir(parents=True)
    monkeypatch.setattr(mod, "STATE_DIR", state_dir)
    # Stable defaults for timing-sensitive tests.
    monkeypatch.setattr(mod, "RUNIR_CAPTURE_STALE_S", 5.0)
    monkeypatch.setattr(mod, "RUNIR_CAPTURE_WAIT_TIMEOUT", 32.0)
    monkeypatch.setattr(mod, "RUNIR_CAPTURE_POLL_INTERVAL", 0.02)
    monkeypatch.setattr(mod, "RUNIR_BATCH_SIBLING_S", 2.0)
    monkeypatch.setattr(mod, "RUNIR_RECALL_DEDUPE_TTL_S", 3600.0)
    monkeypatch.setattr(mod, "RUNIR_RECALL_DEDUPE_MAX", 32)
    return mod
