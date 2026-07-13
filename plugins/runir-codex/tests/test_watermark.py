import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hooks"))

from watermark import load_fallback_hash, load_watermark, save_fallback_hash, save_watermark


class TestLoadWatermark:
    def test_missing_file_returns_zero(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        assert load_watermark("session-1") == 0

    def test_corrupt_file_returns_zero(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text("not json!!!")
        assert load_watermark("session-1") == 0

    def test_missing_session_key_returns_zero(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text(json.dumps({"other-session": {"messageCount": 5}}))
        assert load_watermark("session-1") == 0

    def test_returns_stored_count(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text(json.dumps({"sess-a": {"messageCount": 42, "updatedAt": "2026-04-12T00:00:00Z"}}))
        assert load_watermark("sess-a") == 42


class TestSaveWatermark:
    def test_creates_file_and_dir(self, tmp_path, monkeypatch):
        wm_dir = tmp_path / "subdir"
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(wm_dir))
        save_watermark("sess-1", 10)
        data = json.loads((wm_dir / "capture-watermarks.json").read_text())
        assert data["sess-1"]["messageCount"] == 10

    def test_preserves_other_sessions(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text(json.dumps({"sess-a": {"messageCount": 5, "updatedAt": "2026-04-12T00:00:00Z"}}))
        save_watermark("sess-b", 10)
        data = json.loads(wm_file.read_text())
        assert data["sess-a"]["messageCount"] == 5
        assert data["sess-b"]["messageCount"] == 10

    def test_updates_existing_session(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text(json.dumps({"sess-a": {"messageCount": 5, "updatedAt": "2026-04-12T00:00:00Z"}}))
        save_watermark("sess-a", 15)
        data = json.loads(wm_file.read_text())
        assert data["sess-a"]["messageCount"] == 15

    def test_atomic_write_survives_read_after(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        save_watermark("sess-1", 7)
        assert load_watermark("sess-1") == 7

    def test_corrupt_file_is_overwritten(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        wm_file = tmp_path / "capture-watermarks.json"
        wm_file.write_text("broken!!")
        save_watermark("sess-1", 3)
        data = json.loads(wm_file.read_text())
        assert data["sess-1"]["messageCount"] == 3


class TestFallbackHash:
    def test_missing_hash_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        assert load_fallback_hash("sess-1") is None

    def test_save_and_load_hash(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        save_fallback_hash("sess-1", "abc123")
        assert load_fallback_hash("sess-1") == "abc123"
        assert load_watermark("sess-1") == 0

    def test_save_watermark_preserves_hash(self, tmp_path, monkeypatch):
        monkeypatch.setattr("watermark.WATERMARK_DIR", str(tmp_path))
        save_fallback_hash("sess-1", "abc123")
        save_watermark("sess-1", 4)
        assert load_fallback_hash("sess-1") == "abc123"
        assert load_watermark("sess-1") == 4
