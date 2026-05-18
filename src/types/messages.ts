// WebSocket 协议消息类型（Backend ↔ Extension）

export type ToolName =
  | 'fetch_url'
  | 'tabs_context'
  | 'read_page'
  | 'find'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'scroll_to'
  | 'navigate'
  | 'open_tab'
  | 'screenshot'
  | 'wait'
  | 'browser_batch'
  | 'get_console_logs'
  | 'save_to_local'
  | 'extract_markdown';

export type ExecMode = 'auto' | 'approval' | 'plan';

export interface CredentialOverride {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderRequest {
  provider: string;
  model?: string;
  credentialOverride?: CredentialOverride;
  sessionId?: string;  // for provider_auth_poll
}

export interface ProviderStatus {
  provider: string;
  ok: boolean;
  connected: boolean;
  authType?: string;
  message: string;
  hint?: string;
  loginUrl?: string;
  userCode?: string;
  sessionId?: string;     // from auth_start; UI passes back on poll
  pollInterval?: number;  // seconds
}

export interface UserSettings {
  provider?: string;          // auto / deepseek / openai / anthropic / gemini / openrouter / custom ...
  model?: string;             // provider-specific model id; empty means backend default when provider='auto'
  credentialOverride?: CredentialOverride; // local-only override sent to 127.0.0.1 backend; do not persist in history
  mode?: ExecMode;            // auto = 自动；approval = 逐工具审批；plan = 只读调研
  require_approval?: boolean; // 兼容老字段（true ≈ mode='approval'）
}

// === Backend → Extension ===
export type ServerMessage =
  | { type: 'thinking_delta'; text: string; session_id?: string }
  | { type: 'text_delta'; text: string; session_id?: string }
  | { type: 'tool_call'; id: string; tool: ToolName; args: Record<string, unknown>; session_id: string }
  | { type: 'tool_approval_request'; id: string; tool: ToolName; args: Record<string, unknown>; session_id: string }
  | { type: 'message_complete'; session_id?: string }
  | { type: 'error'; error: string; session_id?: string }
  | { type: 'provider_status_result'; request_id: string; status: ProviderStatus }
  | { type: 'provider_validate_result'; request_id: string; status: ProviderStatus }
  | { type: 'provider_auth_start_result'; request_id: string; status: ProviderStatus }
  | { type: 'provider_auth_poll_result'; request_id: string; status: ProviderStatus }
  | { type: 'provider_logout_result'; request_id: string; status: ProviderStatus }
  | { type: 'pong' };

// === Extension → Backend ===
export type ClientMessage =
  | { type: 'hello'; client: 'chrome-extension'; version: string }
  | { type: 'user_message'; session_id: string; text: string; context?: { url?: string; title?: string }; settings?: UserSettings }
  | { type: 'provider_status'; request_id: string; request: ProviderRequest }
  | { type: 'provider_validate'; request_id: string; request: ProviderRequest }
  | { type: 'provider_auth_start'; request_id: string; request: ProviderRequest }
  | { type: 'provider_auth_poll'; request_id: string; request: ProviderRequest }
  | { type: 'provider_logout'; request_id: string; request: ProviderRequest }
  | { type: 'tool_result'; id: string; ok: true; data: unknown; session_id: string }
  | { type: 'tool_error'; id: string; ok: false; error: string; session_id: string }
  | { type: 'tool_approval'; id: string; approved: boolean; session_id: string }
  | { type: 'stop'; session_id: string }
  | { type: 'ping' };

// === Sidepanel ↔ Background SW（chrome.runtime.sendMessage）===
export type SidepanelMessage =
  | { type: 'SP_SUBMIT'; text: string; settings?: UserSettings }
  | { type: 'SP_PROVIDER_STATUS'; request: ProviderRequest }
  | { type: 'SP_PROVIDER_VALIDATE'; request: ProviderRequest }
  | { type: 'SP_PROVIDER_AUTH_START'; request: ProviderRequest }
  | { type: 'SP_PROVIDER_AUTH_POLL'; request: ProviderRequest }
  | { type: 'SP_PROVIDER_LOGOUT'; request: ProviderRequest }
  | { type: 'SP_STOP' }
  | { type: 'SP_GET_STATUS' }
  | { type: 'SP_SWITCH_TAB'; tabId: number }
  | { type: 'SP_NEW_CHAT' }
  | { type: 'SP_SELECT_SESSION'; sessionId: string }
  | { type: 'SP_TOOL_APPROVAL'; id: string; approved: boolean; session_id: string };

export type SwToSidepanelMessage =
  | { type: 'SW_DELTA'; channel: 'thinking' | 'text'; text: string; session_id?: string }
  | { type: 'SW_TOOL_CALL'; id: string; tool: ToolName; args: Record<string, unknown>; session_id?: string }
  | { type: 'SW_TOOL_RESULT'; id: string; ok: boolean; data?: unknown; error?: string; session_id?: string }
  | { type: 'SW_TOOL_APPROVAL_REQUEST'; id: string; tool: ToolName; args: Record<string, unknown>; session_id: string }
  | { type: 'SW_COMPLETE'; session_id?: string }
  | { type: 'SW_ERROR'; error: string; session_id?: string }
  | { type: 'SW_STATUS'; connected: boolean; sessionId: string | null };
