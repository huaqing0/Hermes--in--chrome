# Hermes in Chrome

> Hermes Agent 住在 Chrome 里 — 浏览器自动化扩展。
> 灵感来自 Claude in Chrome v1.0.70，接入本地 Hermes Backend (`127.0.0.1:8642`)。

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20NC%201.0.0-blue.svg)](./LICENSE)
[![Chrome MV3](https://img.shields.io/badge/chrome-MV3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

> **License**: source-available under [PolyForm Noncommercial 1.0.0](./LICENSE).
> Free for personal / educational / non-profit use.
> **Commercial use** requires a separate license — see [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md).

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

## 从 GitHub 下载和安装

当前版本需要本地构建后，以“加载已解压的扩展程序”的方式安装。

推荐一键安装：

```bash
git clone https://github.com/huaqing0/hermes-in-chrome.git
cd hermes-in-chrome
npm run setup
```

`npm run setup` 会安装依赖、检测/启动 Hermes gateway，并构建扩展。

如果你想手动分步执行：

```bash
npm install
npm run backend:ensure
npm run build
```

然后在 Chrome 里打开：

1. 进入 `chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目生成的 `dist/` 目录
5. 点工具栏图标或按 `Cmd+H` / `Ctrl+H` 打开 sidepanel

开发模式（热重载）：

```bash
npm start
```

如果只是普通使用，推荐走 `npm run setup` + 加载 `dist/`；`npm start` 更适合开发调试。

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

`fetch_url` · `tabs_context` · `read_page` · `find` · `click` · `type` · `key` · `scroll` · `scroll_to` · `navigate` · `open_tab` · `screenshot` · `wait` · `browser_batch` · `get_console_logs`

- `read_page` 和 `ref_id` 操作走 `chrome.scripting.executeScript` 的 **isolated-world**，避免把 a11y tree 暴露到页面主世界
- `browser_batch` 合并可预测的连续动作，减少工具调用 round-trip
- `key` 支持 `Meta+Enter` 这类组合键，供 X / Twitter 等页面走键盘提交

## 依赖与限制

**这是一个 Chrome 扩展前端**，需要配套后端：

- **后端**：Hermes Agent（第三方项目，独立维护），监听 `127.0.0.1:8642`，提供 `/api/ws/extension` WebSocket endpoint
- 后端的 5 个 provider handler（`provider_status` / `provider_validate` / `provider_auth_start` / `provider_auth_poll` / `provider_logout`）以及浏览器工具桥需要在 Hermes Agent 里注册
- 扩展本身不能直接启动本地 Python 进程；请在本地终端运行 `npm run backend:ensure` 做自动检测/启动，或用 `npm run backend:watch` 持续守护

### WebSocket 协议契约

扩展跟后端通过 WebSocket 通信，消息格式见 [`src/types/messages.ts`](./src/types/messages.ts)。理论上你可以写一个兼容的后端替代 Hermes Agent，只要实现：

- `hello` / `user_message` / `tool_result` / `tool_error` / `stop` / `ping`（client → server）
- `thinking_delta` / `text_delta` / `tool_call` / `tool_approval_request` / `message_complete` / `error` / `provider_*_result` / `pong`（server → client）

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

[PolyForm Noncommercial License 1.0.0](./LICENSE)

商用授权见 [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)。

贡献指南见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
