"""Safety tests for scripts/hermes-filewriter.py.

Tests resolve_safe_path path rejection and handle(request) behaviour
without touching real user directories. Uses importlib to load the
module so we stay in sync with the actual file.
"""

import base64
import importlib.util
import json
import os
import struct
import sys
import tempfile
from pathlib import Path

import pytest

# ── Load the filewriter module ──────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent
FW_PATH = REPO_ROOT / "scripts" / "hermes-filewriter.py"
spec = importlib.util.spec_from_file_location("filewriter", FW_PATH)
filewriter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(filewriter)


# ── Helpers ─────────────────────────────────────────────────────

def _send_message_bytes(obj) -> bytes:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def _call_handle(req):
    """Call filewriter.handle(req) and return the response dict."""
    return filewriter.handle(req)


# ── resolve_safe_path tests ─────────────────────────────────────

class TestResolveSafePath:
    """Tests for resolve_safe_path() — path validation and rejection."""

    def test_allows_tempdir_new_file(self):
        path = filewriter.resolve_safe_path(str(Path(tempfile.gettempdir()) / "hermes-test-allowed.txt"))
        assert path is not None

    def test_rejects_empty_path(self):
        with pytest.raises(ValueError, match="path is required"):
            filewriter.resolve_safe_path("")

    def test_rejects_none_path(self):
        with pytest.raises(ValueError, match="path is required"):
            filewriter.resolve_safe_path(None)

    def test_rejects_relative_path(self):
        with pytest.raises(ValueError, match="must be absolute"):
            filewriter.resolve_safe_path("relative/path.txt")

    def test_rejects_root(self):
        with pytest.raises(ValueError, match="root"):
            filewriter.resolve_safe_path("/")

    def test_rejects_etc(self):
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path("/etc/passwd")

    def test_rejects_usr(self):
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path("/usr/local/bin/something")

    def test_rejects_system(self):
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path("/System/Library/test")

    def test_rejects_ssh(self):
        ssh_dir = os.path.expanduser("~/.ssh/test_key")
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path(ssh_dir)

    def test_rejects_aws(self):
        aws_dir = os.path.expanduser("~/.aws/test_file")
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path(aws_dir)

    def test_rejects_gnupg(self):
        gnupg_dir = os.path.expanduser("~/.gnupg/test_file")
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path(gnupg_dir)

    def test_rejects_docker(self):
        docker_dir = os.path.expanduser("~/.docker/test_file")
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path(docker_dir)

    def test_rejects_hermes_own_dir(self):
        hermes_dir = os.path.expanduser("~/.hermes/tokens.json")
        with pytest.raises(ValueError, match="protected"):
            filewriter.resolve_safe_path(hermes_dir)


# ── handle() tests ──────────────────────────────────────────────

class TestHandle:
    """Tests for handle() — the main request dispatcher."""

    def test_ping(self):
        resp = _call_handle({"op": "ping"})
        assert resp["ok"] is True
        assert resp["pong"] is True

    def test_unknown_op(self):
        with pytest.raises(ValueError, match="unknown op"):
            _call_handle({"op": "nonexistent_op"})

    def test_write_utf8_to_temp(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        try:
            resp = _call_handle({
                "op": "write",
                "path": tmp.name,
                "content": "hello world",
                "encoding": "utf8",
                "create_dirs": True,
                "overwrite": True,
            })
            assert resp["ok"] is True
            assert resp["bytes_written"] == 11
        finally:
            os.unlink(tmp.name)

    def test_write_base64_to_temp(self):
        raw = b"binary data \x00\x01\x02"
        b64 = base64.b64encode(raw).decode()
        tmp = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
        tmp.close()
        try:
            resp = _call_handle({
                "op": "write",
                "path": tmp.name,
                "content": b64,
                "encoding": "base64",
                "create_dirs": True,
                "overwrite": True,
            })
            assert resp["ok"] is True
            assert resp["bytes_written"] == len(raw)
            with open(tmp.name, "rb") as f:
                assert f.read() == raw
        finally:
            os.unlink(tmp.name)

    def test_unknown_encoding(self):
        with pytest.raises(ValueError, match="unknown encoding"):
            _call_handle({
                "op": "write",
                "path": "/tmp/test.xyz",
                "content": "data",
                "encoding": "gzip",
            })

    def test_refuses_overwrite_without_flag(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.write(b"original content")
        tmp.close()
        try:
            with pytest.raises(ValueError, match="overwrite"):
                _call_handle({
                    "op": "write",
                    "path": tmp.name,
                    "content": "new content",
                    "encoding": "utf8",
                    "overwrite": False,
                })
        finally:
            os.unlink(tmp.name)

    def test_overwrite_true_allows_overwrite(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.write(b"original content")
        tmp.close()
        try:
            resp = _call_handle({
                "op": "write",
                "path": tmp.name,
                "content": "replaced content",
                "encoding": "utf8",
                "overwrite": True,
            })
            assert resp["ok"] is True
            assert resp["overwritten"] is True
        finally:
            os.unlink(tmp.name)

    def test_missing_content(self):
        with pytest.raises(ValueError, match="content is required"):
            _call_handle({
                "op": "write",
                "path": "/tmp/test.txt",
                "encoding": "utf8",
            })

    def test_utf8_wrong_type(self):
        with pytest.raises(ValueError, match="utf8 content must be a string"):
            _call_handle({
                "op": "write",
                "path": "/tmp/test.txt",
                "content": 12345,
                "encoding": "utf8",
            })

    def test_base64_wrong_type(self):
        with pytest.raises(ValueError, match="base64 content must be a string"):
            _call_handle({
                "op": "write",
                "path": "/tmp/test.txt",
                "content": 12345,
                "encoding": "base64",
            })
