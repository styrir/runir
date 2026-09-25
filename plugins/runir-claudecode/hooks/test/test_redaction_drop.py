import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runir_capture import is_successful_response


def test_redaction_drop_advances_claude_watermark():
    body = {"skipped": False, "reason": "redaction_assertion_failed", "factsFound": 0,
            "outcomes": {"create": 0, "skip": 0, "merge-update": 0, "supersede": 0}, "units": []}
    assert "error" not in body
    assert is_successful_response(200, body)[0] is True
