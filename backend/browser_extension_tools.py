"""
Browser Extension Tools — Hermes Agent 工具桥（完全隔离）

这个模块挂在 hermes-in-chrome 项目里，不在 Hermes 的 tools/ 目录。
import 时通过 Hermes 的公开 API `tools.registry.register()` 动态注册
15 个浏览器工具（前缀 `ext_`），让 AIAgent 能调度 Chrome 扩展执行操作。

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
import json
import logging
import threading
import time
import uuid
from typing import Any, Dict, Optional

log = logging.getLogger("hermes_in_chrome.tools")
AUDIT_LOG_PATH = "/tmp/hermes-in-chrome-tools.jsonl"

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
        with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    except Exception as exc:
        log.debug("写入 Hermes in Chrome 工具审计日志失败: %s", exc)


def set_context(ws: Any, session_id: str, loop: asyncio.AbstractEventLoop) -> None:
    """extension_ws.py 在调 AIAgent.run_conversation 之前调用，把 ws 和 loop 绑到当前 thread。"""
    _local.ws = ws
    _local.session_id = session_id
    _local.loop = loop


def clear_context() -> None:
    for attr in ("ws", "session_id", "loop"):
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
# 工具 schema（15 个工具，加 ext_ 前缀避免与 Hermes 内置工具冲突）
#
# 对应扩展端 src/types/messages.ts 的 ToolName：
#   fetch_url / tabs_context / read_page / find / click / type /
#   scroll / scroll_to / navigate / open_tab / screenshot / wait /
#   browser_batch / get_console_logs
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
            "description": "读取当前 Chrome 页面的 accessibility 树（带 ref_id 的语义结构）。仅在需要点击/输入交互时使用，纯阅读优先用 ext_fetch_url。",
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
                "工具会锁定当前输入作用域；若验证失败，会尝试回滚本次残留输入。"
                "可选 submit=true 只会在验证成功后自动按 Enter。"
                "若返回错误或 verified 不是 true，必须重新读取页面，不要换 ref_id 盲目重试，更不要继续点击发布/发送。"
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
            "description": "截图当前 tab。仅在 ext_read_page 不够（需要视觉判断）时使用。",
            "parameters": {"type": "object", "properties": {}},
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
            "description": "读取页面 console.log/warn/error 等日志（最近 200 条）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {"type": "string", "enum": ["all", "log", "info", "warn", "error", "debug"]},
                    "limit": {"type": "integer"},
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
        # 必须返回 str（Hermes registry 约定）
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
    """把 15 个工具注册到 Hermes registry，toolset='browser-ext'。"""
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
- ext_type(ref_id, text, submit?) — 原子输入文本，并验证当前输入作用域内内容精确等于目标文本；只有 verified=true 才能继续提交
- ext_key(key) — 按键盘快捷键，如 'Enter'、'Meta+Enter'（Mac Cmd+Enter）、'Ctrl+Enter'
- ext_browser_batch(actions) — 批量执行多个可预测浏览器动作，减少 round-trip
- ext_scroll / ext_scroll_to / ext_screenshot / ext_wait / ext_get_console_logs

# 工具使用软建议（自己判断）
- 用户说「打开/查看/操作/播放 X」→ 倾向浏览器路径（ext_navigate + ext_read_page + ext_click）
- 多 tab 任务先 ext_tabs_context；大页面先 ext_find；连续 click/type/wait 优先 ext_browser_batch
- 用户说「查/告诉我 X」→ 倾向 web_search 或 ext_fetch_url
- 搜索引擎结果页是 SPA，fetch_url 拿不到，用 web_search 或浏览器路径
- YouTube/Twitter/Notion 等 SPA 必须走浏览器（ext_navigate + ext_read_page + ext_click）
- **X/Twitter 发帖**：ext_navigate("https://x.com/compose/post") → ext_read_page(filter="interactive") → ext_type(ref_id=帖子文本, text=...)。只有 ext_type 返回 verified=true，且 actual_text_preview 精确等于用户要发的文本后，才能 ext_key(key='Meta+Enter') 或点击“发帖/全部发帖”。如果 ext_type 报错或 verified 不是 true，必须 ext_read_page 重新观察页面，不能直接换另一个“帖子文本” ref_id 盲重试，更不能提交。ext_key 只代表按键已发送，不代表发布成功；按下后必须 ext_wait(1000-3000) + ext_read_page 复查：弹窗关闭、新帖出现在时间线/个人页，才可以说发布成功。如果弹窗仍存在、发帖按钮仍不可用、或草稿文本与用户文本不完全一致，必须告诉用户没有发布成功。只能点击明确叫“发帖”或“全部发帖”的按钮；“添加帖子”是添加 thread 的第二条，不是发布；“下一步”通常不是最终发布。不要反复重复输入同一段文字。
- **YouTube 评论**：先点击评论框 → ext_read_page(filter="interactive") → ext_type(ref_id=评论文本框, text=...)。只有 verified=true，且 actual_text_preview 精确等于用户评论文本后，才能点击“评论”/“Comment”；否则重新读页面，禁止提交空评论或重复评论。点击后必须 ext_wait + ext_read_page 复查评论是否出现，不能只因为点击成功就报告成功。

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
