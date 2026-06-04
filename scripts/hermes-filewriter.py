#!/usr/bin/env python3
"""Hermes in Chrome — Native Messaging file writer host.

Receives length-prefixed JSON requests on stdin from the extension and
writes files anywhere the user has filesystem permission, except system
paths and sensitive user dirs (.ssh, browser profiles, shell rc, etc.).

Protocol (Chrome Native Messaging):
    [u32 little-endian length][UTF-8 JSON body]

Request:
    {"op": "write", "path": "...", "content": "...", "encoding": "utf8"|"base64", "create_dirs": true, "overwrite": false}
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
INSTALL_META_PATH = Path.home() / ".hermes" / "hermes-in-chrome.json"

_IS_WINDOWS = os.name == "nt"
if _IS_WINDOWS:
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def _load_install_meta() -> dict:
    try:
        with INSTALL_META_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}

# System paths shared across users — writing here breaks the OS or other accounts.
DENY_SYSTEM_PREFIXES = (
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

_WINDOWS_DENY_SYSTEM_PREFIXES = (
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\ProgramData",
)

_WINDOWS_DENY_SENSITIVE_FILES = {
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".env",
    "Microsoft.PowerShell_profile.ps1",
    "profile.ps1",
}


def _user_sensitive_paths() -> tuple:
    """Per-user paths agents should never touch: credentials, browser
    profiles, shell rc files, Hermes' own config."""
    home = str(Path.home().resolve())
    if _IS_WINDOWS:
        appdata = os.environ.get("APPDATA", "")
        localappdata = os.environ.get("LOCALAPPDATA", "")
        userprofile = os.environ.get("USERPROFILE", home)
        paths = [
            # Credentials / keys
            f"{home}\\.ssh",
            f"{home}\\.aws",
            f"{home}\\.gnupg",
            f"{home}\\.docker",
            # Browser profiles
            f"{localappdata}\\Google\\Chrome",
            f"{localappdata}\\Chromium",
        ]
        if appdata:
            paths.append(f"{appdata}\\Mozilla\\Firefox")
        if userprofile:
            paths.append(f"{userprofile}\\Documents\\WindowsPowerShell")
        # Also add check for APPDATA-based PowerShell
        if appdata:
            paths.append(f"{appdata}\\Microsoft\\Windows\\PowerShell")
        paths.append(f"{home}\\.hermes")
        return tuple(paths)

    return (
        # Credentials / keys
        f"{home}/.ssh",
        f"{home}/.gnupg",
        f"{home}/.aws",
        f"{home}/.docker",
        f"{home}/.kube",
        f"{home}/.config/gcloud",
        # Browser profiles / keychains / cookies
        f"{home}/Library/Keychains",
        f"{home}/Library/Application Support/Google/Chrome",
        f"{home}/Library/Application Support/Chromium",
        f"{home}/Library/Application Support/Firefox",
        f"{home}/Library/Cookies",
        f"{home}/Library/Safari",
        # Single-file credentials
        f"{home}/.netrc",
        f"{home}/.npmrc",
        f"{home}/.pypirc",
        # Shell rc — overwriting hijacks the next shell session
        f"{home}/.bashrc",
        f"{home}/.bash_profile",
        f"{home}/.zshrc",
        f"{home}/.zprofile",
        f"{home}/.zshenv",
        f"{home}/.profile",
        # Hermes' own state
        f"{home}/.hermes",
    )


def _safe_req_summary(req) -> dict:
    """Return a safe version of the request without the content payload."""
    if not isinstance(req, dict):
        return {"type": type(req).__name__}
    content = req.get("content")
    content_len = len(content) if isinstance(content, str) else None
    return {
        "op": req.get("op"),
        "path": req.get("path"),
        "encoding": req.get("encoding"),
        "create_dirs": req.get("create_dirs"),
        "overwrite": req.get("overwrite"),
        "content_chars": content_len,
    }


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


def _norm_path_for_cmp(p: str) -> str:
    """Normalize a path for comparison: lowercase on Windows, as-is on POSIX."""
    return p.lower() if _IS_WINDOWS else p


def _check_deny(resolved_str: str) -> None:
    """Uniform exact-or-prefix match; works for both directories and single files."""
    cmp_path = _norm_path_for_cmp(resolved_str)

    # System prefixes (platform-specific)
    prefixes = _WINDOWS_DENY_SYSTEM_PREFIXES if _IS_WINDOWS else DENY_SYSTEM_PREFIXES
    for deny in prefixes:
        deny_cmp = _norm_path_for_cmp(deny)
        # Exact match or prefix with separator
        sep = "\\" if _IS_WINDOWS else "/"
        if cmp_path == deny_cmp or cmp_path.startswith(deny_cmp + sep):
            raise ValueError(f"refusing to write protected path: {deny}")

    # User-sensitive paths
    for deny in _user_sensitive_paths():
        deny_cmp = _norm_path_for_cmp(deny)
        sep = "\\" if _IS_WINDOWS else "/"
        if cmp_path == deny_cmp or cmp_path.startswith(deny_cmp + sep):
            raise ValueError(f"refusing to write protected path: {deny}")

    # Windows: check sensitive filenames
    if _IS_WINDOWS:
        fname = _norm_path_for_cmp(Path(resolved_str).name)
        for s in _WINDOWS_DENY_SENSITIVE_FILES:
            if fname == _norm_path_for_cmp(s):
                raise ValueError(f"refusing to write sensitive file: {s}")


def resolve_safe_path(raw: str) -> Path:
    if not raw or not isinstance(raw, str):
        raise ValueError("path is required")

    # Windows: reject UNC paths and \\?\ device paths
    if _IS_WINDOWS:
        cleaned = raw.strip()
        if cleaned.startswith("\\\\"):
            raise ValueError(f"refusing UNC path: {raw}")
        if cleaned.startswith("\\\\?\\"):
            raise ValueError(f"refusing device path: {raw}")

    expanded = os.path.expanduser(os.path.expandvars(raw))
    p = Path(expanded)
    if not p.is_absolute():
        raise ValueError(f"path must be absolute, got: {raw}")
    resolved = p.resolve(strict=False)

    # Drive / filesystem root check
    if _IS_WINDOWS:
        resolved_str = str(resolved)
        # Drive root, e.g. C:\
        if len(resolved_str) == 3 and resolved_str[1] == ":" and resolved_str[2] == "\\":
            raise ValueError("refusing to write to drive root")
    else:
        if resolved == Path("/").resolve():
            raise ValueError("refusing to write to root directory")

    _check_deny(str(resolved))
    return resolved


def handle(req):
    op = req.get("op")
    if op == "ping":
        meta = _load_install_meta()
        return {"ok": True, "pong": True, "repoRoot": meta.get("repoRoot")}
    if op != "write":
        raise ValueError(f"unknown op: {op}")

    path = resolve_safe_path(req.get("path", ""))
    encoding = (req.get("encoding") or "utf8").lower()
    create_dirs = bool(req.get("create_dirs", True))
    overwrite = bool(req.get("overwrite", False))
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

    existed = path.exists()
    if existed and not overwrite:
        raise ValueError(f"refusing to overwrite existing file without overwrite=true: {path}")

    mode = "wb" if overwrite else "xb"
    with path.open(mode) as f:
        f.write(data)

    return {"ok": True, "path": str(path), "bytes_written": len(data), "overwritten": existed}


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
            log(f"[handle-error] {e} req={_safe_req_summary(req)!r}")
        try:
            send_message(resp)
        except Exception as e:
            log(f"[send-error] {e}")
            return


if __name__ == "__main__":
    main()
