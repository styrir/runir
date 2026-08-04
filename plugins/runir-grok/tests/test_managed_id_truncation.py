"""Rúnir-ghe.5: managed id markers must be all-or-nothing under bullet/section caps.

Regression for security-r2 major: prior code truncated the composed bullet and
could emit a partial ``<!--`` while still listing the id in publishedIds.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN / "scripts" / "memory_bridge.py"


@pytest.fixture(scope="module")
def bridge():
    spec = importlib.util.spec_from_file_location("memory_bridge_id_trunc", BRIDGE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _assert_balanced_comments(section: str) -> None:
    assert section.count("<!--") == section.count("-->")
    for line in section.splitlines():
        if "<!--" in line:
            # Every open on a line must close on the same line (no partial <!--).
            assert line.count("<!--") == line.count("-->"), line
            assert (
                "<!--" not in line
                or line.rstrip().endswith("-->")
                or (
                    # Multi-comment lines (header) still balanced
                    line.count("<!--") == line.count("-->")
                )
            )


def test_bullet_cap_never_partial_marker_or_false_published(bridge):
    """Reproduce former PoC: long body + id near MAX_BULLET_CHARS."""
    mid = "abc123xyz"
    marker = f"  <!-- id: {mid} -->"
    maxb = bridge.MAX_BULLET_CHARS

    # Sweep cuts that previously produced opens>closes and lying publishedIds.
    for keep in range(1, len(marker) + 2):
        body_len = (maxb - 1) - 2 - keep
        if body_len < 1:
            continue
        body = "B" * body_len
        section, published = bridge.format_managed_section_with_ids(
            [{"id": mid, "text": body}],
            canary=False,
        )
        _assert_balanced_comments(section)
        markers = bridge.ID_MARKER_RE.findall(section)
        # publishedIds honesty: only fully emitted markers
        assert set(published) <= set(markers)
        assert mid not in published or mid in markers
        # Never a line that opens an HTML comment without closing it.
        for line in section.splitlines():
            if "<!--" in line:
                assert line.count("<!--") == line.count("-->")
        # No partial "<!--" dangling without "-->" on the bullet line.
        bullets = [ln for ln in section.splitlines() if ln.startswith("- B")]
        for bl in bullets:
            if "<!--" in bl:
                assert bl.rstrip().endswith("-->")
                assert f"<!-- id: {mid} -->" in bl or "id:" not in bl


def test_near_cap_body_keeps_intact_marker_when_room(bridge):
    """Body is shortened so the full marker still fits; published includes id."""
    mid = "near-cap-id"
    marker = f"  <!-- id: {mid} -->"
    # Full bullet would exceed cap; after body-first truncate, marker intact.
    body = "Z" * bridge.MAX_BULLET_CHARS  # force body truncation
    section, published = bridge.format_managed_section_with_ids(
        [{"id": mid, "text": body}],
        canary=False,
    )
    _assert_balanced_comments(section)
    assert mid in published
    assert mid in bridge.ID_MARKER_RE.findall(section)
    bullets = [
        ln
        for ln in section.splitlines()
        if ln.startswith("- Z") or ln.startswith("- Z".rstrip())
    ]
    # Find the fact bullet
    fact_lines = [
        ln for ln in section.splitlines() if ln.startswith("- ") and "Z" in ln
    ]
    assert fact_lines
    bl = fact_lines[0]
    assert bl.rstrip().endswith("-->")
    assert f"<!-- id: {mid} -->" in bl
    assert len(bl) <= bridge.MAX_BULLET_CHARS
    assert "…" in bl  # body was truncated


def test_no_id_long_body_still_truncates_cleanly(bridge):
    body = "Q" * (bridge.MAX_BULLET_CHARS + 200)
    section, published = bridge.format_managed_section_with_ids(
        [{"id": None, "text": body}],
        canary=False,
    )
    assert published == []
    _assert_balanced_comments(section)
    fact_lines = [ln for ln in section.splitlines() if ln.startswith("- Q")]
    assert fact_lines
    assert len(fact_lines[0]) <= bridge.MAX_BULLET_CHARS
    assert fact_lines[0].endswith("…")


def test_multi_fact_section_cap_no_partial_last_marker(bridge):
    """Fill near MAX_MANAGED_BYTES; last facts must not leave partial markers."""
    facts = []
    # Many medium facts with ids to approach section cap.
    for i in range(200):
        facts.append({"id": f"fact-{i:04d}", "text": ("word " * 40) + f"#{i}"})
    section, published = bridge.format_managed_section_with_ids(facts, canary=False)
    _assert_balanced_comments(section)
    markers = bridge.ID_MARKER_RE.findall(section)
    assert set(published) == set(markers)
    assert len(published) == len(markers)
    assert (
        len(section.encode("utf-8")) <= bridge.MAX_MANAGED_BYTES + 64
    )  # END + newlines slack
    # Section must include begin/end and balanced comments.
    assert section.count(bridge.BEGIN) == 1
    assert section.count(bridge.END) == 1
    # At least some facts published, not zero under generous budget.
    assert len(published) >= 5
    # Not all 200 fit under 12KiB with markers — cap engaged.
    assert len(published) < 200


def test_published_ids_match_read_managed_ids_roundtrip(bridge, tmp_path):
    mid = "roundtrip-1"
    body = "Y" * (bridge.MAX_BULLET_CHARS - 10)
    section, published = bridge.format_managed_section_with_ids(
        [
            {"id": mid, "text": body},
            {"id": "short", "text": "tiny fact"},
        ],
        canary=False,
    )
    path = tmp_path / "MEMORY.md"
    path.write_text("# Header\n\n" + section, encoding="utf-8")
    parsed = bridge.read_managed_ids(path)
    assert published == parsed or set(published) == set(parsed)
    assert set(published) <= set(parsed) | set(bridge.ID_MARKER_RE.findall(section))
    assert "short" in published
    _assert_balanced_comments(section)


def test_sweep_all_cut_points_opens_equals_closes(bridge):
    """Deterministic host-style sweep: every cut point keeps opens==closes."""
    mid = "sweep-id-99"
    maxb = bridge.MAX_BULLET_CHARS
    bad = []
    for body_len in range(maxb - 40, maxb + 5):
        if body_len < 1:
            continue
        section, published = bridge.format_managed_section_with_ids(
            [{"id": mid, "text": "X" * body_len}],
            canary=False,
        )
        opens = section.count("<!--")
        closes = section.count("-->")
        markers = bridge.ID_MARKER_RE.findall(section)
        if opens != closes or set(published) - set(markers):
            bad.append((body_len, opens, closes, published, markers))
    assert bad == [], f"unbalanced or lying published at body_lens={bad[:5]}"
