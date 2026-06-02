"""
Browser Extension Tools — Hermes Agent 工具桥（完全隔离）

这个模块挂在 hermes-in-chrome 项目里，不在 Hermes 的 tools/ 目录。
import 时通过 Hermes 的公开 API `tools.registry.register()` 动态注册
浏览器工具（前缀 `ext_`），让 AIAgent 能调度 Chrome 扩展执行操作。

工作原理：
1. 每个工具 handler 是 sync 函数，在 AIAgent 的 executor thread 里被调用
2. handler 用 thread-local 拿到当前 ws + asyncio loop（由 extension_ws.py 在 run_in_executor 之前 set）
3. handler 用 asyncio.run_coroutine_threadsafe 把消息发到主 loop（asyncio）
4. 主 loop 通过 ws 发 tool_call 给扩展，等扩展回 tool_result
5. handler 拿到结果返回给 AIAgent

不修改 Hermes 任何文件——所有注入都通过 registry 公开 API。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger("hermes_in_chrome.tools")
AUDIT_LOG_PATH = os.environ.get(
    "HERMES_IN_CHROME_AUDIT_LOG",
    str(Path.home() / ".hermes" / "logs" / "hermes-in-chrome-tools.jsonl"),
)

# ============================================================================
# Thread-local 上下文 + 全局 pending future 表
# ============================================================================

_local = threading.local()  # 当前 thread 的 ws + session + loop

# call_id → asyncio.Future，主 loop 创建，跨 thread 通过 run_coroutine_threadsafe 取
_pending: Dict[str, asyncio.Future] = {}
_pending_lock = threading.Lock()


def _truncate_for_log(value: Any, limit: int = 4000) -> Any:
    """Keep audit records readable without losing the failure signal."""
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        text = str(value)
    if len(text) <= limit:
        return value
    return {"_truncated": True, "chars": len(text), "preview": text[:limit]}


def _append_audit(event: dict) -> None:
    event = {"ts": time.time(), **event}
    try:
        Path(AUDIT_LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    except Exception as exc:
        log.debug("写入 Hermes in Chrome 工具审计日志失败: %s", exc)


def set_context(
    ws: Any,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
    *,
    settings: Optional[dict] = None,
    provider: str = "",
    model: str = "",
) -> None:
    """extension_ws.py 在调 AIAgent.run_conversation 之前调用，把 ws 和 loop 绑到当前 thread。"""
    _local.ws = ws
    _local.session_id = session_id
    _local.loop = loop
    _local.settings = settings or {}
    _local.provider = provider or ""
    _local.model = model or ""


def clear_context() -> None:
    for attr in ("ws", "session_id", "loop", "settings", "provider", "model"):
        if hasattr(_local, attr):
            delattr(_local, attr)


def resolve_tool_result(call_id: str, ok: bool, data: Any = None, error: str = None) -> bool:
    """extension_ws.py 收到扩展的 tool_result 时调用。返回是否找到了 pending future。"""
    with _pending_lock:
        fut = _pending.pop(call_id, None)
    if fut is None or fut.done():
        _append_audit({
            "event": "orphan_tool_result",
            "call_id": call_id,
            "ok": ok,
            "data": _truncate_for_log(data),
            "error": error,
        })
        return False
    _append_audit({
        "event": "tool_result",
        "call_id": call_id,
        "ok": ok,
        "data": _truncate_for_log(data),
        "error": error,
    })
    loop = fut.get_loop()
    if ok:
        loop.call_soon_threadsafe(fut.set_result, data)
    else:
        loop.call_soon_threadsafe(fut.set_exception, RuntimeError(error or "tool error"))
    return True


# ============================================================================
# 工具桥：sync handler → 主 loop 发消息等结果
# ============================================================================

async def _send_and_wait(ws: Any, sid: str, tool_name: str, args: dict, call_id: str) -> Any:
    """在主 loop 运行：发 tool_call 给扩展，等 _pending future resolve。"""
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    with _pending_lock:
        _pending[call_id] = fut
    try:
        _append_audit({
            "event": "tool_call",
            "call_id": call_id,
            "session_id": sid,
            "tool": tool_name,
            "args": _truncate_for_log(args),
        })
        await ws.send_json({
            "type": "tool_call",
            "id": call_id,
            "tool": tool_name,
            "args": args,
            "session_id": sid,
        })
        return await asyncio.wait_for(fut, timeout=60.0)
    finally:
        with _pending_lock:
            _pending.pop(call_id, None)


def _call_extension_tool(tool_name: str, args: dict, **_kw) -> Any:
    """通用 sync handler：所有工具的入口。在 executor thread 跑。"""
    ws = getattr(_local, "ws", None)
    sid = getattr(_local, "session_id", None)
    loop = getattr(_local, "loop", None)
    if not (ws and sid and loop):
        return {"error": "Hermes in Chrome 工具只在扩展上下文里可用（未设置 ws 上下文）"}
    call_id = f"call_{uuid.uuid4().hex[:12]}"
    coro = _send_and_wait(ws, sid, tool_name, args, call_id)
    cf_future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return cf_future.result(timeout=65.0)
    except Exception as e:
        _append_audit({
            "event": "tool_exception",
            "call_id": call_id,
            "session_id": sid,
            "tool": tool_name,
            "args": _truncate_for_log(args),
            "error": str(e),
        })
        return {"error": f"工具执行失败 ({tool_name}): {e}"}


# ============================================================================
# 工具 schema（加 ext_ 前缀避免与 Hermes 内置工具冲突）
#
# 对应扩展端 src/types/messages.ts 的 ToolName：
#   fetch_url / tabs_context / read_page / inspect_targets / find / click / type /
#   hover / right_click / double_click / drag / scroll / scroll_to /
#   navigate / open_tab / close_tab / screenshot / visual_inspect / wait /
#   browser_batch / get_console_logs / read_network_requests / save_to_local / extract_markdown
#
# 扩展端工具名不变；后端 prompt 里 LLM 看到的是 ext_ 前缀名，
# handler 在调用扩展时把前缀去掉，发原始工具名给扩展。
# ============================================================================

TOOLS: list[tuple[str, str, dict]] = [
    (
        "ext_fetch_url",
        "fetch_url",
        {
            "name": "ext_fetch_url",
            "description": "**首选工具**：直接 HTTP GET 一个公开 URL，返回干净的正文 markdown。适合：读新闻 / 文档 / 博客 / RSS / API 返回的 JSON。不适合：需要登录、JS 交互、点击按钮的页面（用 ext_navigate + ext_read_page）。",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "完整 URL"}},
                "required": ["url"],
            },
        },
    ),
    (
        "ext_tabs_context",
        "tabs_context",
        {
            "name": "ext_tabs_context",
            "description": "查看当前 Hermes session 的 tab group 上下文：当前 tab、可用 tab、tabId、标题和 URL。多 tab 操作前优先调用。",
            "parameters": {"type": "object", "properties": {}},
        },
    ),
    (
        "ext_read_page",
        "read_page",
        {
            "name": "ext_read_page",
            "description": "读取当前 Chrome 页面的 accessibility 树（带 ref_id 的语义结构）。仅在需要点击/输入交互时使用，纯阅读优先用 ext_fetch_url。连续两次读取没有新信息时必须换策略或执行下一步，不能反复观察。",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref_id": {"type": "string", "description": "可选：只读以此元素为根的子树"},
                    "depth": {"type": "integer", "description": "最大递归深度，默认 15"},
                    "filter": {"type": "string", "enum": ["all", "interactive"], "description": "all=全部 / interactive=只要可交互元素"},
                },
            },
        },
    ),
    (
        "ext_inspect_targets",
        "inspect_targets",
        {
            "name": "ext_inspect_targets",
            "description": (
                "DOM 级交互目标检查：列出当前可视页面里的输入框和可点击控件，"
                "包括 a11y tree 可能漏掉的 SVG/icon-only 按钮、Shadow DOM 内元素、"
                "以及离输入框最近的候选按钮。适合：ext_find 找不到评论框/发送按钮、"
                "输入成功但发送没有触发、页面用图标按钮提交。返回的 ref_id 可继续用于 ext_click/ext_type。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 120, "description": "每类最多返回多少个目标，默认 60"},
                },
            },
        },
    ),
    (
        "ext_find",
        "find",
        {
            "name": "ext_find",
            "description": "按自然语言在当前页面 a11y tree 中查找元素，返回最多 20 个候选 ref_id。适合在大页面里先找“搜索框/提交按钮/某个链接”，再用 ext_click/ext_type 操作。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要查找的元素描述，例如 search box / 登录按钮 / Add to cart"},
                    "tabId": {"type": "integer", "description": "可选：指定 tabId，通常来自 ext_tabs_context"},
                    "limit": {"type": "integer", "description": "最多返回多少个候选，默认 20"},
                },
                "required": ["query"],
            },
        },
    ),
    (
        "ext_click",
        "click",
        {
            "name": "ext_click",
            "description": "点击页面元素（用 ext_read_page 得到的 ref_id）。",
            "parameters": {
                "type": "object",
                "properties": {"ref_id": {"type": "string"}},
                "required": ["ref_id"],
            },
        },
    ),
    (
        "ext_type",
        "type",
        {
            "name": "ext_type",
            "description": (
                "在输入框/富文本框输入文本，并验证页面真实内容精确等于该文本。"
                "工具会锁定当前目标输入槽位；普通输入框走原生 value，X/YouTube 等富文本框只粘贴一次，随后等待并复查，不会二次粘贴。"
                "如果目标编辑器已经是同一段文本，会直接返回 verified=true，不需要再次输入。"
                "可选 submit=true 会在验证成功后优先点击同一编辑器附近的真实发送/发布按钮；找不到按钮时才回退到 Enter。"
                "若提交后 post_submit_text_still_present=true，说明文字仍留在编辑器里，发布很可能没有成功；这时调用 ext_inspect_targets/ext_visual_inspect/ext_read_network_requests 诊断。"
                "若返回 ref_id/目标不匹配错误，先重新 ext_read_page 定位正确字段；若返回富文本残留/dirty 错误，刷新或重新打开输入页面。"
                "verified 不是 true 时不要继续点击发布/发送。"
                "在 X/YouTube/真实账号页面严禁输入 test、hello、测试 等与用户原文不同的探测文本。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ref_id": {"type": "string", "description": "目标 input/textarea/contenteditable/role=textbox 或其外层容器的 ref_id"},
                    "text": {"type": "string"},
                    "submit": {"type": "boolean"},
                },
                "required": ["text"],
            },
        },
    ),
    (
        "ext_scroll",
        "scroll",
        {
            "name": "ext_scroll",
            "description": "滚动当前页面。",
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["up", "down", "top", "bottom"]},
                    "amount": {"type": "integer"},
                },
                "required": ["direction"],
            },
        },
    ),
    (
        "ext_scroll_to",
        "scroll_to",
        {
            "name": "ext_scroll_to",
            "description": "滚动到指定 ref_id 元素的中心。比 scroll(direction) 更精准。",
            "parameters": {
                "type": "object",
                "properties": {"ref_id": {"type": "string"}},
                "required": ["ref_id"],
            },
        },
    ),
    (
        "ext_navigate",
        "navigate",
        {
            "name": "ext_navigate",
            "description": "在当前 tab 导航到 URL。",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    ),
    (
        "ext_open_tab",
        "open_tab",
        {
            "name": "ext_open_tab",
            "description": "在 Hermes 专属 Tab Group 里打开新 tab，用于多源调研、并行查资料。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "switch": {"type": "boolean", "description": "默认 true：把后续操作切到这个新 tab"},
                },
                "required": ["url"],
            },
        },
    ),
    (
        "ext_screenshot",
        "screenshot",
        {
            "name": "ext_screenshot",
            "description": "截图当前 tab，会返回较大的 base64。主要用于保存/调试；需要理解图片、视频画面、canvas、图标状态或视觉布局时，优先用 ext_visual_inspect，不要直接靠 ext_screenshot 看图。",
            "parameters": {"type": "object", "properties": {}},
        },
    ),
    (
        "ext_visual_inspect",
        "visual_inspect",
        {
            "name": "ext_visual_inspect",
            "description": (
                "视觉检查当前页面截图，并返回可用于下一步操作的观察结果。"
                "如果当前主模型支持视觉，截图会作为真实 image 输入交给 GPT/Claude/Gemini 等模型；"
                "如果当前主模型不支持视觉，则自动调用 Hermes auxiliary.vision 生成文字分析。"
                "适合：图片、视频画面、canvas、图标按钮、视觉布局、a11y tree 看不到的页面状态。"
                "普通网页读文字/找按钮仍优先 ext_read_page/ext_find。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "你希望视觉模型回答的问题，例如“评论框在哪里？”或“这个视频画面里有什么？”",
                    },
                    "ref_id": {
                        "type": "string",
                        "description": "可选：只检查某个元素区域。需要先用 ext_read_page 得到 ref_id。",
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["viewport", "element"],
                        "description": "viewport=当前可视区域；element=指定 ref_id 元素区域。默认有 ref_id 时 element，否则 viewport。",
                    },
                },
            },
        },
    ),
    (
        "ext_wait",
        "wait",
        {
            "name": "ext_wait",
            "description": "等待指定毫秒（动态加载场景用，最多 10000ms）。",
            "parameters": {
                "type": "object",
                "properties": {"ms": {"type": "integer", "description": "毫秒，最多 10000"}},
                "required": ["ms"],
            },
        },
    ),
    (
        "ext_browser_batch",
        "browser_batch",
        {
            "name": "ext_browser_batch",
            "description": "批量执行多个浏览器工具动作，减少多轮工具调用延迟。适合可预测的 click→type→wait、表单填写、连续滚动/点击。遇到错误会停止后续动作。",
            "parameters": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "description": "动作列表。每项形如 {tool:'click', args:{ref_id:'ref_1'}} 或 {name:'type', input:{text:'hello'}}。工具名使用扩展端原始名，不带 ext_ 前缀。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "tool": {"type": "string", "description": "原始工具名，如 click/type/wait/scroll/navigate/read_page/find"},
                                "name": {"type": "string", "description": "tool 的别名字段"},
                                "args": {"type": "object", "description": "工具参数"},
                                "input": {"type": "object", "description": "args 的别名字段"},
                            },
                        },
                    },
                },
                "required": ["actions"],
            },
        },
    ),
    (
        "ext_get_console_logs",
        "get_console_logs",
        {
            "name": "ext_get_console_logs",
            "description": "读取页面 console 日志（CDP + fallback hook，最近 200 条，支持 page/JS 错误）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {"type": "string", "enum": ["all", "log", "info", "warn", "error", "debug"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                    "tabId": {"type": "integer", "description": "可选：指定 tabId，通常来自 ext_tabs_context"},
                },
            },
        },
    ),
    (
        "ext_read_network_requests",
        "read_network_requests",
        {
            "name": "ext_read_network_requests",
            "description": "读取当前 tab 最近网络请求（CDP Network），默认返回 200 条以内元数据，默认不返回 body。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer", "description": "可选：指定 tabId，通常来自 ext_tabs_context"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                    "filter": {"type": "string", "description": "可选：按 method/url/type/resourceType 关键词过滤"},
                    "includeHeaders": {"type": "boolean", "description": "返回时包含 requestHeaders/responseHeaders（敏感值会脱敏）"},
                    "includeFailed": {"type": "boolean", "description": "true 时也返回 failed 请求"},
                    "includeBody": {"type": "boolean", "description": "true 时尝试获取 response body（默认关闭，且会截断）"},
                },
            },
        },
    ),
    (
        "ext_hover",
        "hover",
        {
            "name": "ext_hover",
            "description": "把鼠标移动到指定位置或 ref_id 中心。用于触发 hover/tooltip 或验证可见性。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer"},
                    "ref_id": {"type": "string", "description": "目标 ref_id（与 x/y 二选一）"},
                    "x": {"type": "integer", "description": "目标 x 坐标（与 ref_id 二选一）"},
                    "y": {"type": "integer", "description": "目标 y 坐标（与 ref_id 二选一）"},
                },
            },
        },
    ),
    (
        "ext_right_click",
        "right_click",
        {
            "name": "ext_right_click",
            "description": "在 ref_id 或坐标位置执行右键点击。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer"},
                    "ref_id": {"type": "string", "description": "目标 ref_id（与 x/y 二选一）"},
                    "x": {"type": "integer", "description": "目标 x 坐标（与 ref_id 二选一）"},
                    "y": {"type": "integer", "description": "目标 y 坐标（与 ref_id 二选一）"},
                },
            },
        },
    ),
    (
        "ext_double_click",
        "double_click",
        {
            "name": "ext_double_click",
            "description": "在 ref_id 或坐标位置执行双击。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer"},
                    "ref_id": {"type": "string", "description": "目标 ref_id（与 x/y 二选一）"},
                    "x": {"type": "integer", "description": "目标 x 坐标（与 ref_id 二选一）"},
                    "y": {"type": "integer", "description": "目标 y 坐标（与 ref_id 二选一）"},
                },
            },
        },
    ),
    (
        "ext_drag",
        "drag",
        {
            "name": "ext_drag",
            "description": "从起点拖到终点。起点/终点支持 ref_id 或坐标（from_ref_id/to_ref_id 或 from_x/y/to_x/y）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer"},
                    "from_ref_id": {"type": "string", "description": "起点 ref_id（与 from_x/from_y 二选一）"},
                    "to_ref_id": {"type": "string", "description": "终点 ref_id（与 to_x/to_y 二选一）"},
                    "from_x": {"type": "integer", "description": "起点 x（与 from_ref_id 二选一）"},
                    "from_y": {"type": "integer", "description": "起点 y（与 from_ref_id 二选一）"},
                    "to_x": {"type": "integer", "description": "终点 x（与 to_ref_id 二选一）"},
                    "to_y": {"type": "integer", "description": "终点 y（与 to_ref_id 二选一）"},
                },
            },
        },
    ),
    (
        "ext_close_tab",
        "close_tab",
        {
            "name": "ext_close_tab",
            "description": "关闭当前 tab 或指定 tabId。未显式指定且非受控 tab 不会误关。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tabId": {"type": "integer", "description": "可选：要关闭的 tabId；未传则关闭当前 tab"},
                    "force": {
                        "type": "boolean",
                        "description": "显式关闭非 Hermes 管理 tab 时设为 true（请先确认这是用户当前意图）",
                    },
                },
            },
        },
    ),
    (
        "ext_key",
        "key",
        {
            "name": "ext_key",
            "description": "按下键盘快捷键。支持修饰键组合，用 '+' 连接，如 'Enter'、'Meta+Enter'（Mac Cmd+Enter）、'Ctrl+Enter'、'Shift+Tab'。注意：此工具只证明按键已发送，不证明表单已经提交成功。X/Twitter 发帖：输入文字后先用 ext_key(key='Meta+Enter')；随后必须 ext_wait + ext_read_page 复查弹窗是否关闭或新帖是否出现。若弹窗仍存在，再读弹窗并点击“发帖/全部发帖”按钮，绝不要点击“添加帖子”。",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "按键名，支持修饰键前缀：Meta（Mac Cmd）、Ctrl、Alt、Shift，用 '+' 连接，如 'Meta+Enter'。",
                    },
                },
                "required": ["key"],
            },
        },
    ),
    (
        "ext_save_to_local",
        "save_to_local",
        {
            "name": "ext_save_to_local",
            "description": (
                "把任意文本/二进制内容写到用户本地文件系统的绝对路径，通过 Chrome Native Messaging "
                "调用本地 hermes-filewriter 进程。需要用户先跑过 install-native-host 安装步骤。"
                "用于持久化：ext_fetch_url 拿到的 HTML/文本、ext_read_page 的 a11y 树、"
                "ext_screenshot 截图（必须 encoding='base64'）、ext_extract_markdown 生成的 Markdown。"
                "路径必须是绝对路径（如 ~/Downloads/page.md、~/Documents/Hermes/note.html，"
                "或your-ssd /Volumes/.../x.md），~ 会被本地 host 展开到 $HOME。"
                "用户文件系统下的任何位置都可以写，但系统目录（/System、/usr、/etc 等）"
                "和敏感用户目录（~/.ssh、~/.aws、浏览器 profile、~/.zshrc 等 shell rc）会被拒绝，"
                "防止意外覆盖凭据或劫持 shell。"
                "默认拒绝覆盖已有文件；确实要覆盖时必须显式传 overwrite=true。"
                "文件名由你自己决定，建议 {host}_{slug}_{YYYYMMDD-HHmmss}.{ext} 之类避免重名。"
                "成功返回 {saved:true, path, bytes_written, encoding, overwritten}；失败抛错并提示如何安装 host。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "绝对路径，~ 会被展开。父目录不存在会自动创建（除非 create_dirs=false）",
                    },
                    "content": {
                        "type": "string",
                        "description": "要写入的内容。utf8 编码下直接是字符串；base64 编码下是 base64 字符串（用于 PNG/JPEG 等二进制）",
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf8", "base64"],
                        "description": "默认 utf8。screenshot 这种二进制必须用 base64",
                    },
                    "create_dirs": {
                        "type": "boolean",
                        "description": "父目录不存在时是否自动 mkdir -p（默认 true）",
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "是否允许覆盖已有文件（默认 false；除非用户明确要求，否则不要设为 true）",
                    },
                },
                "required": ["path", "content"],
            },
        },
    ),
    (
        "ext_extract_markdown",
        "extract_markdown",
        {
            "name": "ext_extract_markdown",
            "description": (
                "把当前 Chrome 页面正文转成 Markdown。会跳过 script/style/nav/footer 等噪声，"
                "保留 h1-h6/p/ul/ol/blockquote/pre/code/table/img/链接。"
                "返回 {url, title, markdown, truncated}；超长会截断到 max_chars（默认 500000）。"
                "典型组合：ext_navigate → ext_extract_markdown → ext_save_to_local(path=..., content=md.markdown)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "max_chars": {
                        "type": "integer",
                        "description": "截断阈值，默认 500000，最大 2000000",
                    },
                },
            },
        },
    ),
]


# ============================================================================
# fetch_url 特殊后处理：扩展返回 raw html，后端用 trafilatura 抽干净 markdown
# ============================================================================

def _postprocess_fetch_url(result: Any) -> Any:
    if not isinstance(result, dict) or "html" not in result:
        return result
    try:
        import trafilatura
    except ImportError:
        return {**result, "_warning": "trafilatura 未安装"}
    html = result.get("html", "") or ""
    ct = (result.get("content_type") or "").lower()
    out = {k: v for k, v in result.items() if k != "html"}
    if "application/json" in ct or result.get("url", "").endswith(".json"):
        out["content_type"] = "json"
        out["text"] = html[:10000]
        return out
    md = trafilatura.extract(html, output_format="markdown", include_links=True, favor_precision=True) or html[:5000]
    out["content_type"] = "html"
    out["markdown"] = md[:10000]
    return out


def _run_async_tool(awaitable: Any) -> Any:
    """Run a Hermes async tool from the sync browser-ext handler thread."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(awaitable)

    # The browser-ext handler normally runs in an executor thread without a
    # running loop. Keep this fallback for unusual embedders.
    box: dict[str, Any] = {}

    def _runner() -> None:
        try:
            box["result"] = asyncio.run(awaitable)
        except BaseException as exc:  # pragma: no cover - defensive
            box["error"] = exc

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _settings_vision_override() -> Optional[bool]:
    settings = getattr(_local, "settings", {}) or {}
    value = settings.get("vision") if isinstance(settings, dict) else None
    if value is True or value is False:
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "vision"}:
            return True
        if lowered in {"false", "no", "text", "text_only", "text-only"}:
            return False
    return None


def _model_supports_native_vision(provider: str, model: str) -> bool:
    override = _settings_vision_override()
    if override is not None:
        return override

    provider_l = (provider or "").strip().lower()
    model_l = (model or "").strip().lower()
    if provider_l in {"deepseek"}:
        return False

    try:
        from agent.models_dev import get_model_capabilities

        caps = get_model_capabilities(provider_l, model)
        if caps is not None:
            return bool(caps.supports_vision)
    except Exception as exc:
        log.debug("模型视觉能力查询失败 provider=%s model=%s: %s", provider, model, exc)

    if provider_l in {"anthropic", "claude"} and "claude" in model_l:
        return True
    if provider_l in {"openai", "openai-codex", "azure-openai"} and (
        model_l.startswith("gpt-4o")
        or model_l.startswith("gpt-5")
        or "vision" in model_l
    ):
        return True
    if provider_l in {"gemini", "google", "google-gemini", "google-vertex-gemini"} and "gemini" in model_l:
        return True
    if provider_l == "openrouter" and any(
        needle in model_l for needle in ("claude", "gpt-4o", "gpt-5", "gemini", "llava", "vision")
    ):
        return True
    return False


def _write_visual_inspect_image(result: dict) -> Path:
    data = result.get("data")
    if not isinstance(data, str) or not data:
        raise RuntimeError("visual_inspect returned no screenshot data")
    fmt = str(result.get("format") or "jpeg").lower()
    suffix = ".png" if fmt == "png" else ".jpg"
    image_bytes = base64.b64decode(data, validate=True)
    cache_dir = Path.home() / ".hermes" / "cache" / "hermes-in-chrome" / "vision"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"visual_inspect_{uuid.uuid4().hex}{suffix}"
    path.write_bytes(image_bytes)
    return path


def _visual_prompt(result: dict) -> str:
    question = result.get("question")
    if not isinstance(question, str) or not question.strip():
        question = "Describe the visible browser page and identify anything important for the next browser action."
    url = result.get("url") or ""
    title = result.get("title") or ""
    scope = result.get("scope") or "viewport"
    return (
        "You are inspecting a screenshot from Hermes in Chrome. "
        "Give a concise, actionable description for browser automation. "
        "Read visible text carefully. Mention UI controls, disabled/enabled state, "
        "visual layout, and anything not available from an accessibility tree.\n\n"
        f"Question: {question.strip()}\n"
        f"Scope: {scope}\n"
        f"Page title: {title}\n"
        f"URL: {url}"
    )


def _postprocess_visual_inspect(result: Any) -> Any:
    if not isinstance(result, dict):
        return result
    if result.get("error"):
        return result

    image_path: Optional[Path] = None
    provider = getattr(_local, "provider", "") or ""
    model = getattr(_local, "model", "") or ""
    prompt = _visual_prompt(result)
    try:
        image_path = _write_visual_inspect_image(result)
        native = _model_supports_native_vision(provider, model)

        if native:
            from tools.vision_tools import _vision_analyze_native

            native_result = _run_async_tool(_vision_analyze_native(str(image_path), prompt))
            if isinstance(native_result, dict) and native_result.get("_multimodal") is True:
                meta = native_result.setdefault("meta", {})
                if isinstance(meta, dict):
                    meta.update({
                        "vision_route": "main_model_native",
                        "provider": provider,
                        "model": model,
                        "source": "hermes-in-chrome",
                        "scope": result.get("scope") or "viewport",
                        "url": result.get("url") or "",
                        "title": result.get("title") or "",
                    })
                native_result["text_summary"] = (
                    f"Screenshot attached natively for {provider}/{model}. "
                    "Use built-in vision to answer the visual inspection question."
                )
                return native_result
            log.warning("native visual_inspect did not return multimodal result; falling back to auxiliary vision")

        from tools.vision_tools import vision_analyze_tool

        analysis_json = _run_async_tool(vision_analyze_tool(str(image_path), prompt))
        parsed: Any
        try:
            parsed = json.loads(analysis_json) if isinstance(analysis_json, str) else analysis_json
        except Exception:
            parsed = {"success": False, "analysis": str(analysis_json)}
        if not isinstance(parsed, dict):
            parsed = {"success": False, "analysis": str(parsed)}
        return {
            "success": bool(parsed.get("success")),
            "analysis": parsed.get("analysis") or parsed.get("error") or "Vision analysis returned no text.",
            "error": parsed.get("error"),
            "vision_route": "auxiliary",
            "provider": provider,
            "model": model,
            "scope": result.get("scope") or "viewport",
            "url": result.get("url") or "",
            "title": result.get("title") or "",
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"visual_inspect failed: {exc}",
            "analysis": (
                "当前模型无法完成视觉检查。请切换到支持视觉的 GPT/Claude/Gemini 模型，"
                "或配置 Hermes auxiliary.vision 后重试。"
            ),
            "vision_route": "error",
            "provider": provider,
            "model": model,
        }
    finally:
        if image_path is not None:
            try:
                image_path.unlink(missing_ok=True)
            except Exception:
                pass


def _make_handler(ext_tool_name: str):
    """工厂：生成一个 sync handler。绑定原始扩展端工具名。

    必须返回 str（JSON 序列化）— Hermes 内部期望 str 类型工具结果，
    会对 result 做 slice 截断等字符串操作。返回 dict 会触发
    `unhashable type: 'slice'` 错误。
    """
    def handler(args, **kw):
        result = _call_extension_tool(ext_tool_name, args or {}, **kw)
        if ext_tool_name == "fetch_url":
            result = _postprocess_fetch_url(result)
        elif ext_tool_name == "visual_inspect":
            result = _postprocess_visual_inspect(result)
            if isinstance(result, dict) and result.get("_multimodal") is True:
                return result
        # 普通工具返回 str；visual_inspect 的原生视觉路径可返回 _multimodal dict，
        # run_agent 会把它作为真正的图片 tool result 交给视觉模型。
        if isinstance(result, str):
            return result
        try:
            return json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            return json.dumps({"result_repr": str(result)[:5000]}, ensure_ascii=False)
    return handler


# ============================================================================
# 注册到 Hermes registry（模块 import 时执行）
# ============================================================================

def _register_all() -> None:
    """把浏览器扩展工具注册到 Hermes registry，toolset='browser-ext'。"""
    try:
        from tools.registry import registry
    except ImportError as e:
        log.error("无法 import Hermes registry: %s", e)
        return

    for prefixed_name, raw_name, schema in TOOLS:
        handler = _make_handler(raw_name)
        registry.register(
            name=prefixed_name,
            toolset="browser-ext",
            schema=schema,
            handler=handler,
            check_fn=None,  # 始终可用（扩展可用与否由 check_context 在 handler 里报错）
            requires_env=[],
            is_async=False,  # sync handler；内部用 run_coroutine_threadsafe 跨线程
            description=schema.get("description", ""),
            emoji="🌐",
        )
    log.info("✅ browser-ext toolset 已注册 %d 个工具", len(TOOLS))


_register_all()


# ============================================================================
# 给 Hermes Agent 的 system prompt 加几条额外规则
# ============================================================================

EXTRA_SYSTEM_PROMPT = """\
你现在在 Chrome 浏览器扩展（Hermes in Chrome）里运行。除了你的常规工具，你还有：

# 浏览器交互工具（ext_* 前缀）
- ext_fetch_url(url) — HTTP GET 拿干净 markdown（适合公开静态内容；SPA 网页拿不到）
- ext_navigate(url) / ext_open_tab(url) — 在用户的 Chrome 里跳转/开新 tab（用户能看到）
- ext_tabs_context() — 查看当前 Hermes tab group 里有哪些 tab；多 tab 操作前优先用
- ext_read_page(ref_id?, depth?, filter?) — 读当前页 a11y 树，拿可点击元素的 ref_id
- ext_find(query) — 在大页面里按自然语言找候选 ref_id，再 click/type
- ext_click(ref_id) — 真实点击
- ext_type(ref_id, text, submit?) — 原子输入文本；只验证当前目标输入槽位精确等于 text，不要求同一表单里的标题/正文等其它字段为空；普通输入框走原生 value，X/YouTube 富文本框只走一次可信粘贴路径，然后等待并复查，不会二次粘贴；如果框内已经是同一文本会直接返回 verified=true；只有 verified=true 才能继续提交
- ext_hover(ref_id?, x?, y?) / ext_right_click(ref_id?, x?, y?) / ext_double_click(ref_id?, x?, y?) — 基础鼠标交互
- ext_drag(from_ref_id?, to_ref_id?, from_x?, from_y?, to_x?, to_y?) — 拖拽交互（支持按坐标或 ref_id）
- ext_close_tab(tabId?, force?) / ext_read_network_requests(...) — tab 和网络可观测工具
- ext_key(key) — 按键盘快捷键，如 'Enter'、'Meta+Enter'（Mac Cmd+Enter）、'Ctrl+Enter'
- ext_browser_batch(actions) — 批量执行多个可预测浏览器动作，减少 round-trip
- ext_visual_inspect(question?, ref_id?, scope?) — 视觉检查页面截图；视觉主模型会真实看到图片，无视觉主模型会走 auxiliary.vision 返回文字观察
- ext_scroll / ext_scroll_to / ext_screenshot / ext_wait / ext_get_console_logs

# 工具使用软建议（自己判断）
- 用户说「打开/查看/操作/播放 X」→ 倾向浏览器路径（ext_navigate + ext_read_page + ext_click）
- 多 tab 任务先 ext_tabs_context；大页面先 ext_find；连续 click/type/wait 优先 ext_browser_batch
- 用户说「查/告诉我 X」→ 倾向 web_search 或 ext_fetch_url
- 搜索引擎结果页是 SPA，fetch_url 拿不到，用 web_search 或浏览器路径
- YouTube/Twitter/Notion 等 SPA 必须走浏览器（ext_navigate + ext_read_page + ext_click）
- **通用发帖/评论流程**：先确认目标上下文，再输入。评论任务必须先进入具体内容页/帖子页/视频页；发帖任务必须先进入创建/投稿页面。不要在首页、搜索页、频道页、subreddit 列表页直接输入评论或正文。表单有多个槽位时按“标题、正文、评论框、提交按钮”分别定位；每填完一个字段后重新 ext_read_page(filter="interactive")，因为 ref_id 可能会失效。提交前最后复查：目标文本在正确字段里、提交/发布/评论按钮存在且可用，再点击。ext_type 如果返回 ref_id 不存在、目标内容不匹配、目标错位，先重新读页面找正确字段；如果返回富文本残留/dirty，再刷新或重新打开 composer。不要在同一个坏 ref_id 上反复 type。
- **多字段表单**：Reddit、论坛、CMS 等页面常见“标题 textarea + 正文富文本/textarea”。标题已有内容不代表正文输入失败；正文已有内容也不代表标题失败。分别填各自 ref_id，不要把另一个字段的正常内容当作残留。
- **浏览器操作节流**：每个浏览器任务都要维护“我在哪、目标控件是什么、下一步动作是什么”。到达目标页并找到评论框/输入框后，下一步必须 click/type/verify，不能继续截图或无目的地 read_page。连续 2 次 ext_read_page 没有发现新的可操作目标时，必须改用 ext_find、scroll_to、click/type，或向用户说明卡点。连续 2 次 ext_wait 后仍无新内容时，停止等待并换策略。单个发帖/评论任务超过 15 次浏览器工具调用仍未输入目标文本时，必须停止并报告具体卡在哪，不要继续消耗 40 步预算。
- **截图克制**：ext_screenshot 会把很大的图片内容塞进上下文。只有在 a11y 树看不到必要视觉信息时才截图；不能把截图用作常规“看一下页面”的步骤。截图后必须立即基于截图做一个动作或报告障碍，不能截图后继续重复读取。
- **视觉能力**：需要看图片、视频画面、canvas、图标状态、视觉布局、颜色/高亮/禁用状态时，用 ext_visual_inspect，不要用 ext_screenshot 来理解页面。ext_visual_inspect 会优先让 GPT/Claude/Gemini 等当前视觉主模型直接看图；DeepSeek 等无视觉模型会得到 auxiliary.vision 的文字分析。如果它返回未配置视觉后端，明确告诉用户需要切换视觉模型或配置 auxiliary.vision，不要反复截图。
- **从新标签页开始的评论任务**：先用确定性 URL 或站内搜索进入具体内容页；如果用户说“某频道/某作者最新视频/帖子”，进入对应列表页后选择最靠前的公开视频/帖子，再进入详情页。到详情页后如果已经找到 comment/textbox/ref_id，就立即点击并 ext_type 用户原文；不要切换移动版，不要输入测试文本，不要因为页面有搜索框就把评论写到搜索框。
- **抖音/B站评论**：播放器底部的「弹幕/发弹幕」输入框不是评论框，不能把评论写到那里，也不能点击弹幕发送。评论任务必须进入视频详情的评论区/评论列表附近，选择带有「评论/回复/留下评论」语义的文本框；如果只看到播放器控制栏或弹幕框，先滚动/打开评论区，找不到就报告卡点，不要硬发。
- **X/Twitter 发帖**：ext_navigate("https://x.com/compose/post") → ext_read_page(filter="interactive") → ext_type(ref_id=帖子文本, text=用户原文)。只能输入用户明确要求发布的原文，严禁为了测试输入 `test`、`hello`、`测试`、占位文字或任何与用户原文不同的内容。只有 ext_type 返回 verified=true，且 actual_text_preview 精确等于用户要发的文本后，才能 ext_key(key='Meta+Enter') 或点击“发帖/全部发帖”。如果 ext_type 报错或 verified 不是 true，必须刷新或重新打开 compose 页面后再从头观察，不能直接换另一个“帖子文本” ref_id 重试，更不能提交。ext_key 只代表按键已发送，不代表发布成功；按下后必须 ext_wait(1000-3000) + ext_read_page 复查：弹窗关闭、新帖出现在时间线/个人页，才可以说发布成功。如果弹窗仍存在、发帖按钮仍不可用、或草稿文本与用户文本不完全一致，必须告诉用户没有发布成功。只能点击明确叫“发帖”或“全部发帖”的按钮；“添加帖子”是添加 thread 的第二条，不是发布；“下一步”通常不是最终发布。不要反复重复输入同一段文字。
- **YouTube 评论**：先点击评论框 → ext_read_page(filter="interactive") → ext_type(ref_id=评论文本框, text=用户原文)。只能输入用户明确要求评论的原文，严禁输入 `test`、`hello`、`测试`、占位文字或任何与用户原文不同的内容。只有 verified=true，且 actual_text_preview 精确等于用户评论文本后，才能点击“评论”/“Comment”；否则刷新或重新打开评论框后再从头观察，禁止提交空评论或重复评论。点击后必须 ext_wait + ext_read_page 复查评论是否出现，不能只因为点击成功就报告成功。

# 严格按字面理解
- 「最早 / 第一支 / first / oldest」→ 按时间最远那个，不是最新
- 「最新 / 最近 / latest」→ 时间最近那个
- 不要意译，按用户字面说的来

# 铁律
- 别说「session 未初始化」「SPA 渲染未就绪」这种开发术语，用人话（如"页面还在加载"）
- 整个 session 最多开 5 个新 tab
- 任务完成必须给用户文本总结
- 复杂多步任务用 todo 工具跟踪进度
"""
