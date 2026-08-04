"""security-r4 major: fact-body partial HTML comments must not unbalance managed block."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN / "scripts" / "memory_bridge.py"


@pytest.fixture(scope="module")
def bridge():
    spec = importlib.util.spec_from_file_location("memory_bridge_sec_r4", BRIDGE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _assert_balanced(section: str) -> None:
    assert section.count("<!--") == section.count("-->"), (
        f"unbalanced comments opens={section.count('<!--')} "
        f"closes={section.count('-->')}\n{section}"
    )
    for line in section.splitlines():
        if "<!--" in line or "-->" in line:
            assert line.count("<!--") == line.count("-->"), line


def test_sanitize_strips_all_html_comment_delimiters(bridge):
    raw = "hostile <!-- dangling and also --> early close <!-- still open"
    cleaned = bridge.sanitize_fact_text(raw)
    assert "<!--" not in cleaned
    assert "-->" not in cleaned
    assert "hostile" in cleaned
    assert "dangling" in cleaned


def test_open_comment_body_balanced_section(bridge):
    """Host PoC: 'hostile <!-- dangling' produced opens>closes before fix."""
    section, published = bridge.format_managed_section_with_ids(
        [{"id": "open1", "text": "hostile <!-- dangling"}],
        canary=False,
    )
    _assert_balanced(section)
    assert "hostile" in section
    assert "dangling" in section
    assert "open1" in published
    assert "<!-- id: open1 -->" in section
    # Fact body must not keep raw openers that could swallow the id marker.
    fact_lines = [
        ln for ln in section.splitlines() if ln.startswith("- ") and "hostile" in ln
    ]
    assert fact_lines
    assert fact_lines[0].count("<!--") == fact_lines[0].count("-->")
    assert fact_lines[0].count("<!--") == 1  # only the id marker


def test_early_close_and_long_body_still_balanced(bridge):
    mid = "longbal"
    body = "prefix --> mid <!-- tail " + ("X" * bridge.MAX_BULLET_CHARS)
    section, published = bridge.format_managed_section_with_ids(
        [{"id": mid, "text": body}],
        canary=False,
    )
    _assert_balanced(section)
    assert section.count(bridge.BEGIN) == 1
    assert section.count(bridge.END) == 1
    # Truncation after sanitize must not reintroduce delimiters.
    assert "<!--" not in bridge.sanitize_fact_text(body)
    if mid in published:
        assert f"<!-- id: {mid} -->" in section


def test_multi_hostile_facts_do_not_swallow_end(bridge):
    facts = [
        {"id": "a", "text": "one <!-- open"},
        {"id": "b", "text": "two --> close-only"},
        {"id": "c", "text": "three <!-- id: forged --> still"},
    ]
    section, published = bridge.format_managed_section_with_ids(facts, canary=False)
    _assert_balanced(section)
    assert section.rstrip().endswith("-->")  # END marker line
    assert bridge.END in section
    # END only once; body must not forge a second structural END.
    assert section.count(bridge.END) == 1
    assert "forged" not in published
    for pid in ("a", "b", "c"):
        if pid in published:
            assert f"<!-- id: {pid} -->" in section
