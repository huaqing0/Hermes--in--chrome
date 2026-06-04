# Hermes in Chrome

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/huaqing0/Hermes--in--chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/huaqing0/Hermes--in--chrome/actions/workflows/ci.yml)
[![Chrome MV3](https://img.shields.io/badge/chrome-MV3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20experimental-lightgrey.svg)](./docs/windows.md)

> 一个住在 Chrome 侧边栏里的网页 Agent —— 它能直接处理你眼前的真实网页：总结视频、解释文章 / 论文 / 帖子、分析创作者后台、打开指定内容，并在你确认后操作表单或账号。
>
> [← English version](./README.md)

> **当前状态**：早期预览版。**macOS + Chrome** 是主支持运行环境；**Windows + Chrome** 为 experimental —— Native Messaging host 注册、backend 启动和 `save_to_local` 已实现，但还需要真实 Windows 验证。Linux 暂不支持。

![Hermes sidepanel](docs/sidepanel.png)

## 能干什么

Hermes 适合做普通聊天 Agent 很难做好的网页现场任务：它依赖你当前打开的页面、视频、账号和后台数据。

- **总结当前视频**：「总结这个 YouTube / B 站视频，列出关键观点和时间点。」
- **解释当前页面**：「解释这篇文章 / 论文 / 帖子。它的核心观点是什么？证据是什么？我应该注意什么？」
- **分析创作者后台**：「打开创作者中心，根据播放量、完播率、流量来源和评论，分析我这条视频为什么这样表现。」
- **打开和定位内容**：「帮我打开那个讲浏览器 Agent 的访谈视频」或「把这个视频跳到 40:50。」
- **操作登录后的网页**：「根据这条帖子帮我写一条推文，确认后发布」或「把当前页面的数据填进这个表单。」

Agent 能读当前页面，自己开一组 Tab，理解动态网页，用 Chrome DevTools 真截图、真点击、真打字——你在自己的 Tab 里照常工作，互不干扰。

## 你需要准备

| 条件 | 去哪获取 |
|------|---------|
| **Hermes Agent** v0.2.0+ | [github.com/huaqing0/hermes-agent](https://github.com/huaqing0/hermes-agent) — 本地运行的后端，驱动 AI |
| **一个 LLM API Key** | DeepSeek、Anthropic Claude、Google Gemini、OpenAI 或任何兼容 OpenAI 接口的服务商 |
| **macOS 或 Windows** | macOS 完整支持；Windows experimental（见下方说明） |
| **Chrome** 116+ | [google.com/chrome](https://www.google.com/chrome/) |

无需注册云端账号——所有数据都在你本机。API Key 直连你选的 LLM 服务商。

> **License**: [MIT](./LICENSE).

---

## 三件核心能力

1. **住在网页里** — Chrome sidepanel 永驻右侧，AI 流式回复
2. **实时感知页面** — 每次 action 后 agent 主动 `read_page` 拿 a11y tree
3. **自主开 tab** — 在专属 Hermes Tab Group 里串/并行调研，不打扰用户

## 架构

```
sidepanel (React + Vite)
   ↑↓
Service Worker  ←→ WebSocket ←→ Hermes Agent (Python)
   ├─ chrome.debugger (CDP: 截图/点击/输入)
   ├─ chrome.tabGroups (会话隔离)
   └─ content scripts (a11y-tree isolated world 自动注入)
```

## 安装

> **开始前确认**：先安装 Hermes Agent v0.2.0+。从解压后的 `hermes-in-chrome` 文件夹里，在 sidepanel 提示启动后端时运行：
> ```bash
> npm run backend:ensure
> ```
> 这个启动器会自动把 `HERMES_IN_CHROME_BACKEND_PATH` 指向本包自带的 `backend/` bridge。若你手动运行 `hermes gateway run`，需要自己设置这个环境变量。

### 快速安装（无需开发工具）

1. 到 [Releases](https://github.com/huaqing0/Hermes--in--chrome/releases) 页面下载最新的 `hermes-in-chrome.zip`
2. 解压 → 打开 `chrome://extensions` → 启用**开发者模式** → **加载已解压的扩展程序** → 选解压出来的 `hermes-in-chrome/` 文件夹
3. macOS 用 `Cmd+H`，Windows 用 `Ctrl+H` 打开侧边栏 → 按状态条引导操作

### 开发者安装（如需改代码）

三步走：

1. **克隆 + 构建**：

   ```bash
   git clone https://github.com/huaqing0/Hermes--in--chrome.git
   cd hermes-in-chrome
   npm install && npm run build
   ```

2. **Chrome 加载扩展**：`chrome://extensions` → 右上角开「开发者模式」→ 「加载已解压的扩展程序」→ 选本项目的 `dist/` 目录

3. **macOS 用 `Cmd+H`，Windows 用 `Ctrl+H` 打开 sidepanel** —— 按顶部状态条的引导一步步跑命令即可，**不需要自己抄扩展 ID 或翻 README 找命令**

状态条会依次引导你：

- ① 启动本地 Hermes 后端（一键复制 `npm run backend:ensure` 到终端跑）
- ② 注册 Native Messaging host（自动填好你的扩展 ID，一键复制整条命令）
- ③ 选 provider / 填 API Key（或走 OAuth）

三项全绿后状态条会自动折叠成一行小绿点 `● 后端 ● Host ● Provider`，点击可重新展开。

开发模式（热重载）：

```bash
npm start
```

（普通使用走上面三步即可；`npm start` 适合改 React 代码时热重载用。）

## 后端自动检测和启动

Hermes in Chrome 需要本地 Hermes gateway，默认连接：

```text
ws://127.0.0.1:8642/api/ws/extension
```

检查后端是否已启动：

```bash
npm run backend:status
```

如果没有启动，自动在后台启动：

```bash
npm run backend:ensure
```

如果你希望本地使用时后端被杀掉后自动拉起，开一个终端运行：

```bash
npm run backend:watch
```

这个脚本会：

1. 检测 `127.0.0.1:8642` 是否可连接
2. 如果已启动，直接退出
3. 如果未启动，优先使用 `~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run`
4. 找不到本地 venv 时，回退到 PATH 里的 `hermes gateway run`
5. 日志写到 `~/.hermes/logs/hermes-in-chrome-gateway.log`

`backend:watch` 会复用同一套检测/启动逻辑，并在前台持续守护；普通一次性启动用 `backend:ensure`。

如果你的 Hermes Agent 不在默认位置，可以指定路径：

```bash
HERMES_AGENT_DIR=/path/to/hermes-agent npm run backend:ensure
```

如果你的 gateway 不使用默认端口：

```bash
HERMES_GATEWAY_PORT=8642 npm run backend:ensure
```

### Hermes Agent bridge 要求

扩展的浏览器工具（`click`、`type`、`read_page` 等）依赖 Python bridge（`backend/browser_extension_tools.py`），此文件必须能被 Hermes Agent gateway import。内置启动器（`npm run backend:ensure`）会自动设置 `HERMES_IN_CHROME_BACKEND_PATH` 环境变量。

**验证 bridge 是否可用：**

```bash
npm run check-bridge
```

此脚本检查：
- Hermes gateway 在 `http://127.0.0.1:8642/health` 是否健康
- `HERMES_IN_CHROME_BACKEND_PATH` 是否指向包含 `browser_extension_tools.py` 的目录
- gateway 日志是否确认 bridge 已成功加载

如果检查失败，重新运行 `npm run backend:ensure` 即可 — 它会自动将正确的路径传给 gateway。

## 主题

侧边栏自带两套主题，header 第一个按钮切换：

- **CP2077 Dystopia** — 静态黄黑 hazard 边框、Rajdhani 工业字体、八角切角组件
- **80s Synthwave** — 动态霓虹流光边框、紫粉渐变、Orbitron + VT323 字体、Tron 透视网格

主题持久化到 `chrome.storage.local`。

## 模型与 Provider

侧边栏支持 provider + model 两级切换，齿轮 ⚙ 按钮进入配置：

**API Key providers**：DeepSeek / Anthropic Claude / Google Gemini / xAI Grok / Alibaba DashScope (Qwen) / Kimi (Moonshot) / Z.ai (GLM) / MiniMax / Custom OpenAI-compatible

**OAuth providers**：OpenAI Codex / Qwen OAuth / Google Gemini CLI / MiniMax OAuth / Nous Portal — 点击「登录 X」会自动打开 device code 链接，扩展会轮询登录状态

**Auto**：默认走 Hermes 后端当前配置（不在前端覆盖）

### 配置 API Key 的两种方式

**推荐：放在后端**（不会进 chrome.storage，不会进对话历史）：

```bash
cp .env.example ~/.hermes/.env
# 然后编辑 ~/.hermes/.env，填入你自己的 key
```

`.env.example` 示例：

```bash
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_API_KEY=...
XAI_API_KEY=...
DASHSCOPE_API_KEY=...
KIMI_API_KEY=...
GLM_API_KEY=...
MINIMAX_API_KEY=...
```

**前端覆盖**：齿轮 ⚙ → 选 provider → 输入 API Key / Base URL → **测试连接**（会真 ping provider，识别 401/403）→ 保存

前端覆盖的 key 只保存在 `chrome.storage.local`，并且只发送给 `127.0.0.1` 本地后端，**不会**写入对话历史或仓库。

### Custom / Local

适配 Ollama、vLLM、LM Studio、私有 OpenAI-compatible 网关：选 `Custom / Local` → 填 Base URL + Model ID + 可选 API Key。

## 工具集

核心浏览器工具：

`fetch_url` · `tabs_context` · `read_page` · `find` · `click` · `hover` · `right_click` · `double_click` · `drag` · `type` · `key` · `scroll` · `scroll_to` · `navigate` · `open_tab` · `close_tab` · `screenshot` · `visual_inspect` · `wait` · `browser_batch` · `get_console_logs` · `read_network_requests` · `save_to_local` · `extract_markdown`

- `read_page` 和 `ref_id` 操作走 `chrome.scripting.executeScript` 的 **isolated-world**，避免把 a11y tree 暴露到页面主世界
- `browser_batch` 合并可预测的连续动作，减少工具调用 round-trip
- `key` 支持 `Meta+Enter` 这类组合键，供 X / Twitter 等页面走键盘提交
- `type` 对 X / YouTube 等富文本框会临时使用剪贴板粘贴整段文本，并在完成后恢复剪贴板；如果恢复时降级为纯文本或恢复失败，会在工具结果里标明 `clipboard_restore_mode`
- `visual_inspect` 走真正的视觉通道：GPT / Claude / Gemini 等视觉主模型会收到真实图片；DeepSeek 等纯文本模型会走 Hermes `auxiliary.vision`，拿到短文字分析
- `save_to_local` 通过本地 Native Messaging host 把任意文本/二进制内容写到本地任何用户可写位置（除系统目录和 `~/.ssh` 等敏感目录外），无需任何配置，需要先跑一次安装步骤；`extract_markdown` 把当前 Chrome 页面正文转 Markdown，常和 `save_to_local` 配合做"抓页面 + 落盘"

## 保存抓取内容到本地（Native Messaging）

`save_to_local` 让 agent 把 `fetch_url` 的 HTML、`read_page` 的 a11y 树、`screenshot` 的截图、`extract_markdown` 的 Markdown 等内容写到本地文件。路径可以是用户文件系统下的任何位置（`~/Downloads/`、`C:\Users\you\Downloads\`、`/Volumes/your-ssd/`、`/tmp/` 等都可以），无需任何配置。Chrome 扩展本身不能直接写文件，所以走 Native Messaging 调用一个本地 Python 小进程 `hermes-filewriter.py`。

**首次安装（一次性）**：推荐打开 sidepanel，按顶部状态条引导走，**它会自动填好你的扩展 ID 并给出一键复制的命令**。如果你想手动跑：

1. 到 `chrome://extensions` 复制 Hermes in Chrome 的 ID（32 位 a-p 小写字母）
2. 注册 Native Messaging host：

   ```bash
   npm run native-host:install -- <你的扩展ID>
   ```

这个脚本会：

- 把 `scripts/hermes-filewriter.py` 复制到用户级 Hermes Native Messaging 目录（macOS 是 `~/.hermes/native-messaging/`，Windows 是 `%USERPROFILE%\.hermes\native-messaging\`）
- macOS：在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.filewriter.json` 写入 host manifest，并把你的扩展 ID 加进 `allowed_origins`
- Windows experimental：在 `%USERPROFILE%\.hermes\native-messaging\com.hermes.filewriter.json` 写入 manifest，并注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter`
- 把项目根目录记录到 macOS 的 `~/.hermes/hermes-in-chrome.json` 或 Windows 的 `%USERPROFILE%\.hermes\hermes-in-chrome.json`，这样 sidepanel 可以生成已解析路径的 `cd ...` / PowerShell `Set-Location ...` 命令
- 之后在 Chrome 重新加载扩展即可生效

**安全边界**：

- host 接受绝对路径并展开 `~`，可以写到用户文件系统下任何位置；系统目录（`/System`、`/usr`、`/etc`、`C:\Windows`、`C:\Program Files` 等）和敏感用户目录（`~/.ssh`、`~/.aws`、浏览器 profile、shell rc、PowerShell profile 等）始终被拒绝，防止 prompt injection 取走凭据或劫持 shell
- 默认拒绝覆盖已有文件；确实要覆盖时，工具调用必须显式传 `overwrite=true`
- Native Messaging 请求信封上限 64 MiB；base64 编码的二进制数据需留出编码膨胀空间，实际可写内容略小于 64 MB
- host 返回的消息非常小，远低于 Chrome 对 native host→extension 方向的 1 MiB 限制
- 日志在 macOS 写到 `~/.hermes/logs/hermes-filewriter.log`，Windows 写到 `%USERPROFILE%\.hermes\logs\hermes-filewriter.log`

**典型调用**：

```text
ext_extract_markdown()                # 返回 {url, title, markdown}
→ ext_save_to_local(path="~/Downloads/page.md", content=<上一步.markdown>)

ext_screenshot()                      # 返回 base64
→ ext_save_to_local(path="~/Downloads/page.jpg", content=<base64>, encoding="base64")
```

## 隐私与权限

这个扩展是**本地优先**的。对话内容、页面 DOM、截图、API key —— 任何东西都**只发送到 `127.0.0.1:8642`**（你本机的 Hermes Agent）。你选的 LLM provider 收到的只是 Hermes 后端显式转发的部分。`visual_inspect` 会把截图发送给当前视觉 provider，或你配置的 Hermes `auxiliary.vision` provider。

MV3 manifest 申请了下列权限，每个都有具体用途：

| 权限 | 用途 |
|------|------|
| `sidePanel` | 在 Chrome 侧边栏渲染聊天 UI |
| `storage` | 在本地持久化主题 / 语言 / API key 覆盖 |
| `activeTab`, `tabs` | 读取当前 tab 的 URL/title，给 agent 提供上下文 |
| `scripting` | 注入 `a11y-tree.ts`（isolated world），让 agent 能把页面 DOM 当结构化数据读 |
| `debugger` | 通过 CDP 驱动页面（真实截图、真实 Cmd+V 粘贴、真实鼠标点击）。任何**操作**页面（而不只是读取）的工具都需要它 |
| `tabGroups` | 把 agent 开的 tab 归到专属「Hermes」组，让调研不污染你正常的工作区 |
| `webNavigation` | 检测 agent 驱动的页面什么时候加载完，再去读它 |
| `alarms`, `offscreen` | 让 service worker 在 LLM 流式回复期间保持存活；offscreen document 承载剪贴板读写用于富文本输入 |
| `notifications` | 长时间运行任务完成 / 出错时通知用户 |
| `clipboardRead`, `clipboardWrite` | 在向 X / YouTube 等粘贴富文本前快照你的剪贴板，粘贴后恢复。**剪贴板内容永远不会离开本机。** 全 snapshot/restore 不支持时，结果里会标 `clipboard_restore_mode: 'text'`；恢复失败时会标 `clipboard_restore_mode: 'failed'` |
| `nativeMessaging` | 跟 `hermes-filewriter`（独立 Python 进程）通信以本地落盘。没装就无法用 `save_to_local` |
| `host_permissions: <all_urls>` | agent 要在你指向的任何 URL 上操作；没法预先知道你会去哪些站 |

更完整的安全边界见 [Threat model](./docs/threat-model.md)。

我们**不会**做的：

- 没有 analytics、telemetry、外部追踪信标
- 不引用第三方 CDN 或网络字体（sidepanel 只用系统字体）
- 关闭 sidepanel 时除了跟本机 Hermes 后端的 WebSocket 心跳，没有任何后台活动
- 用了 `debugger` 权限的扩展，agent 在运行时 Chrome 会显示「This browser is being controlled by a debugger」横幅 —— 这是正常的，你可以随时点横幅停止

## 依赖与限制

**这是一个 Chrome 扩展前端**，需要配套后端：

- **macOS + Chrome** 是主支持运行环境。**Windows + Chrome** 为 experimental；Native Messaging host 注册、本地 filewriter 和 backend 启动已实现，但仍需要真实 Windows 验证。Linux 暂不支持。
- **后端**：Hermes Agent（第三方项目，独立维护），监听 `127.0.0.1:8642`，提供 `/api/ws/extension` WebSocket endpoint
- 后端的 5 个 provider handler（`provider_status` / `provider_validate` / `provider_auth_start` / `provider_auth_poll` / `provider_logout`）以及浏览器工具桥需要在 Hermes Agent 里注册
- 扩展本身不能直接启动本地 Python 进程；请在本地终端运行 `npm run backend:ensure` 做自动检测/启动，或用 `npm run backend:watch` 持续守护
- 扩展请求 `clipboardRead` / `clipboardWrite` 只用于本地富文本输入：临时保存用户原剪贴板、写入要粘贴的文本、完成后恢复；能使用完整 Clipboard API 时会保留图片/富文本等类型，否则降级为纯文本恢复，并在工具结果里标明；不会把剪贴板内容发送到远程服务

### WebSocket 协议契约

扩展跟后端通过 WebSocket 通信，消息格式见 [`src/types/messages.ts`](./src/types/messages.ts)。理论上你可以写一个兼容的后端替代 Hermes Agent，只要实现：

- `hello` / `user_message` / `tool_result` / `tool_error` / `stop` / `ping`（client → server）
- `thinking_delta` / `text_delta` / `tool_call` / `tool_approval_request` / `message_complete` / `error` / `provider_*_result` / `pong`（server → client）

### Windows 支持（experimental）

在 Windows 上，Native Messaging host 通过注册表登记。需要 **Node.js** 和 **Python 3** 在 PATH 中。

```powershell
# 安装 host
npm run native-host:install -- <你的扩展ID>

# 检查状态
npm run native-host:status

# 验证注册表
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter

# 卸载
npm run native-host:uninstall
```

后端启动同样使用 `npm run backend:ensure`（Windows 上 venv Python 路径为 `venv\Scripts\python.exe`）。

**已知限制**：
- Windows 支持为 experimental，未经完整测试
- 只支持 Chrome（不支持 Edge、Brave 等 Chromium 衍生浏览器的注册表路径）
- 需要真实 Windows + Chrome 环境验证

详细说明见 [docs/windows.md](./docs/windows.md)。

---

## 已知限制

- macOS 为主支持平台，Windows 为 experimental；Linux 暂不支持。
- 扩展依赖本地 Hermes Agent 后端，单独安装扩展不能直接跑 browser-agent 任务。
- Hermes in Chrome 还没有上架 Chrome Web Store；请从 release zip 安装，或从源码构建。
- agent 操作页面时 Chrome 会显示 debugger 控制横幅，这是使用 Chrome DevTools Protocol 驱动页面时的正常现象。

## 项目结构

```
src/
├── sidepanel/        # React UI (App.tsx, styles.css, index.html)
├── background/       # Service Worker (WS 连接、消息路由、tab 管理)
├── content/          # 内容脚本 (a11y-tree.ts, visual-indicator.ts)
├── offscreen/        # offscreen document
├── types/            # TypeScript 类型定义
└── manifest.json     # MV3 manifest
backend/              # 后端要加载的浏览器工具桥（Python，要被 Hermes Agent import）
public/icons/         # 扩展图标
```

## License

[MIT](./LICENSE)

贡献指南见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
