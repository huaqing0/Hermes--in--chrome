#!/usr/bin/env python3
"""Hermes in Chrome — Native Messaging file writer host.

Receives length-prefixed JSON requests on stdin from the extension and
writes files to disk. Allows arbitrary paths under $HOME and
/Volumes/, refuses obvious system paths.

Protocol (Chrome Native Messaging):
    [u32 little-endian length][UTF-8 JSON body]

Request:
    {"op": "write", "path": "...", "content": "...", "encoding": "utf8"|"base64", "create_dirs": true}
    {"op": "ping"}

Response:
    {"ok": true, "path": "/abs/path", "bytes_written": 1234}
    {"ok": false, "error": "reason"}
"""

import base64
import json
import os
import struct
import sys
from pathlib import Path

LOG_PATH = Path.home() / ".hermes" / "logs" / "hermes-filewriter.log"

# Refuse anything that resolves to these prefixes
DENY_PREFIXES = (
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var/db",
    "/Library/Apple",
    "/private/etc",
    "/private/var/db",
)


def log(line: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line.rstrip() + "\n")
    except Exception:
        pass


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len <= 0 or msg_len > 64 * 1024 * 1024:
        raise ValueError(f"invalid message length: {msg_len}")
    data = sys.stdin.buffer.read(msg_len)
    if len(data) != msg_len:
        raise ValueError("short read")
    return json.loads(data.decode("utf-8"))


def send_message(obj) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def resolve_safe_path(raw: str) -> Path:
    if not raw or not isinstance(raw, str):
        raise ValueError("path is required")
    expanded = os.path.expanduser(os.path.expandvars(raw))
    p = Path(expanded)
    if not p.is_absolute():
        raise ValueError(f"path must be absolute, got: {raw}")
    resolved = p.resolve(strict=False)
    s = str(resolved)
    for deny in DENY_PREFIXES:
        if s == deny or s.startswith(deny + "/"):
            raise ValueError(f"refusing to write under system path: {s}")
    if s in ("/", ""):
        raise ValueError("refusing to write to root")
    return resolved


def handle(req):
    op = req.get("op")
    if op == "ping":
        return {"ok": True, "pong": True}
    if op != "write":
        raise ValueError(f"unknown op: {op}")

    path = resolve_safe_path(req.get("path", ""))
    encoding = (req.get("encoding") or "utf8").lower()
    create_dirs = bool(req.get("create_dirs", True))
    content = req.get("content")
    if content is None:
        raise ValueError("content is required")

    if encoding == "utf8":
        if not isinstance(content, str):
            raise ValueError("utf8 content must be a string")
        data = content.encode("utf-8")
    elif encoding == "base64":
        if not isinstance(content, str):
            raise ValueError("base64 content must be a string")
        data = base64.b64decode(content)
    else:
        raise ValueError(f"unknown encoding: {encoding}")

    if create_dirs:
        path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("wb") as f:
        f.write(data)

    return {"ok": True, "path": str(path), "bytes_written": len(data)}


def main() -> None:
    log(f"[start] pid={os.getpid()}")
    while True:
        try:
            req = read_message()
        except Exception as e:
            log(f"[read-error] {e}")
            return
        if req is None:
            log("[eof] stdin closed")
            return
        try:
            resp = handle(req)
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
            log(f"[handle-error] {e} req={req!r}")
        try:
            send_message(resp)
        except Exception as e:
            log(f"[send-error] {e}")
            return


if __name__ == "__main__":
    main()
