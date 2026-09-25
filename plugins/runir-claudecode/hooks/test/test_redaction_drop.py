import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runir_capture import is_successful_response, read_messages
from runir_watermark import bump_epoch, load_epoch, load_watermark, save_watermark


def test_redaction_drop_advances_claude_watermark():
    body = {"skipped": False, "reason": "redaction_assertion_failed", "factsFound": 0,
            "outcomes": {"create": 0, "skip": 0, "merge-update": 0, "supersede": 0}, "units": []}
    assert "error" not in body
    assert is_successful_response(200, body)[0] is True


def test_absolute_ordinals_survive_watermark_slice(tmp_path):
    transcript = tmp_path / "synthetic.jsonl"
    transcript.write_text("\n".join([
        '{"type":"user","message":{"content":"synthetic one"}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"synthetic two"}]}}',
    ]) + "\n")
    assert [message["turnIndex"] for message in read_messages(str(transcript))] == [0, 1]


def test_claude_compaction_epoch_survives_retry(tmp_path, monkeypatch):
    monkeypatch.setattr("runir_watermark.WATERMARK_DIR", str(tmp_path))
    save_watermark("synthetic-session", 5)
    assert bump_epoch("synthetic-session") == 1
    assert load_watermark("synthetic-session") == 0
    assert load_epoch("synthetic-session") == 1
