import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const LANG_STORAGE_KEY = 'hermes_lang';

type Dict = Record<string, string>;

const ZH: Dict = {
  // Header / logo
  header_settings: '模型与密钥设置',
  header_theme_to_synthwave: '切换到 Synthwave 80s',
  header_theme_to_dystopia: '切换到 CP2077 主题',
  header_history: '历史对话',
  header_export_md: '导出对话为 Markdown',
  header_new_chat: '新对话',
  header_lang_toggle: '切换语言 / Switch language',
  status_online: 'ONLINE',
  status_offline: 'OFFLINE',
  system_op: 'SYSTEM // OPERATIONAL · {n} TOOLS',
  tab_tag: '// TAB',

  // Onboarding
  ob_summary_backend: '后端',
  ob_summary_host: 'Host',
  ob_summary_provider: 'Provider',
  ob_toggle_collapse: '折叠',
  ob_toggle_expand: '展开 onboarding',
  ob_repo_placeholder: '<hermes-in-chrome 项目目录>',
  ob_backend_title_checking: '① 本地 Hermes 后端：检测中…',
  ob_backend_title_fail: '① 本地 Hermes 后端 未运行',
  ob_paste_to_terminal: '复制下面这整段，粘贴到终端跑：',
  ob_replace_placeholder_backend: '把 <hermes-in-chrome 项目目录> 换成你 git clone 的实际路径。装好下面 ② Native host 后，这里会自动填好。',
  ob_replace_placeholder_install: '把 <hermes-in-chrome 项目目录> 换成你 git clone 的实际路径。',
  ob_hint_install_agent: '如果你还没装 Hermes Agent，请先按 README 装好。',
  ob_recheck: '已运行，重新检测',
  ob_host_title_checking: '② Native Messaging host：检测中…',
  ob_host_title_fail: '② Native Messaging host 未安装',
  ob_host_body: '装好后 agent 才能把网页内容、截图存到本地。',
  ob_host_ext_id: '你的扩展 ID：',
  ob_host_ext_id_loading: '加载中…',
  ob_host_after_install: '运行成功后请在 chrome://extensions 重新加载本扩展，然后回这里点「已运行，重新检测」。',
  ob_host_error_prefix: '错误：',
  ob_provider_title_checking: '③ Provider / 模型配置：检测中…',
  ob_provider_title_fail: '③ Provider / 模型配置 未就绪',
  ob_provider_body_checking: '正在检测后端配置、OAuth 登录状态或本地 API Key/Base URL。',
  ob_provider_body_fail: '可使用后端配置、OAuth 登录，或在扩展本地保存 API Key/Base URL；选 Auto 使用后端默认配置。',
  ob_open_settings: '打开 ⚙ 配置',

  // History panel
  history_title: '历史对话',
  history_empty: '这个组还没有历史',
  history_count_suffix: '条',

  // Settings panel
  settings_title: '模型设置',
  settings_close: '关闭设置',
  settings_model_id: 'Model ID',
  settings_model_id_placeholder_auto: 'Hermes backend default',
  settings_local_note: '默认推荐把密钥放在 Hermes 后端；这里填写的密钥只保存在 Chrome 本地，并且只发送给 127.0.0.1 后端。',
  settings_api_key: 'API Key',
  settings_apikey_placeholder_auto: 'Auto 使用后端配置',
  settings_apikey_placeholder_default: '可选：覆盖后端 API Key',
  settings_base_url: 'Base URL',
  settings_baseurl_placeholder_auto: 'Auto 使用后端配置',
  settings_baseurl_placeholder_default: '可选：自定义 OpenAI-compatible endpoint',
  settings_status_auto: '后端默认',
  settings_status_local_override: '已保存本地覆盖',
  settings_status_backend_cred: '使用后端凭据',
  settings_clear: '清除',
  settings_save: '保存',
  settings_section_status: '服务端连接状态',
  settings_section_actions: '操作按钮',
  settings_querying: '查询中…',
  settings_no_status: '未查询，点测试连接或登录。',
  settings_refresh: '刷新',
  settings_test_conn: '测试连接',
  settings_login_with: '登录 {provider}',
  settings_logout: '登出',
  settings_finish_login: '完成登录',
  settings_device_code: '设备码',
  settings_oauth_hint: '在浏览器完成授权后会自动检测。',
  settings_cancel: '取消',

  // Provider banner
  banner_backend_offline: '后端未连接',
  banner_backend_offline_hint: '在项目目录运行 npm run backend:ensure 脚本会检测并启动本地 Hermes gateway。',
  banner_provider_checking: '正在检测模型配置…',
  banner_provider_checking_hint: '正在检查 {provider} 是否可用。',
  banner_provider_not_ready: '未就绪',
  banner_copy_cmd: '复制命令',
  banner_recheck: '重新检测',
  banner_open_settings: '打开设置',
  banner_provider_not_set: '未配置：{provider}，请打开右上角 ⚙ 配置 API Key 或登录。',
  banner_provider_status_failed: '无法查询 provider 状态',
  banner_send_failed: '发送失败',
  banner_send_failed_hint: '发送失败',
  banner_login_failed: '启动登录失败',
  banner_login_failed_hint: '启动登录失败。',
  banner_login_incomplete: '登录未完成',
  banner_login_success: '登录成功。',
  banner_status_query_failed: '状态查询失败',
  banner_validate_failed: '验证失败',
  banner_logout_failed: '登出失败',
  banner_running_switch_confirm: '当前任务仍在运行，要切到新对话吗？',

  // Approval
  approval_want_run: '想执行',
  approval_allowed: '已允许',
  approval_denied: '已拒绝',
  approval_allow: '允许',
  approval_deny: '拒绝',

  // Input / feed
  input_placeholder: '告诉 Hermes 你想做什么，比如「查一下 Sonnet 4 最新论文，列三篇」',
  input_send: '发送',
  input_stop: '停止',
  feed_you: '你',
  feed_dialog: '对话',
  feed_step: '步',
  feed_thinking_segments: '{n} 段思考',
  feed_tool_count: '{n} 个工具',
  feed_tool_count_with_err: '{n} 个工具（含错误）',
  feed_reply_segments: '{n} 段中间回复',
  feed_process_label: '过程（{n}）',
  feed_new_message: '新消息',
  feed_collapse: '收起',
  feed_expand: '展开',
  feed_tool_running: '工具中',
  feed_tool_break: '工具组打断 ai 连续性',
  feed_approval: '审批',

  // Exec mode
  mode_auto: '自动执行（Accept edits）',
  mode_auto_short: '自动',
  mode_plan: '计划模式（只读调研）',
  mode_plan_short: '计划',

  // CopyBtn
  copy_done: '已复制',
  copy_do: '复制',
};

const EN: Dict = {
  // Header / logo
  header_settings: 'Model & credential settings',
  header_theme_to_synthwave: 'Switch to Synthwave 80s',
  header_theme_to_dystopia: 'Switch to CP2077 theme',
  header_history: 'Conversation history',
  header_export_md: 'Export conversation as Markdown',
  header_new_chat: 'New chat',
  header_lang_toggle: 'Switch language / 切换语言',
  status_online: 'ONLINE',
  status_offline: 'OFFLINE',
  system_op: 'SYSTEM // OPERATIONAL · {n} TOOLS',
  tab_tag: '// TAB',

  // Onboarding
  ob_summary_backend: 'Backend',
  ob_summary_host: 'Host',
  ob_summary_provider: 'Provider',
  ob_toggle_collapse: 'Collapse',
  ob_toggle_expand: 'Expand onboarding',
  ob_repo_placeholder: '<hermes-in-chrome project dir>',
  ob_backend_title_checking: '① Local Hermes backend: checking…',
  ob_backend_title_fail: '① Local Hermes backend is not running',
  ob_paste_to_terminal: 'Copy the whole line below and paste it into your terminal:',
  ob_replace_placeholder_backend: 'Replace <hermes-in-chrome project dir> with the actual path you cloned to. Once ② Native host below is installed, this will auto-fill.',
  ob_replace_placeholder_install: 'Replace <hermes-in-chrome project dir> with the actual path you cloned to.',
  ob_hint_install_agent: 'If you have not installed Hermes Agent yet, please follow the README first.',
  ob_recheck: 'Done — recheck',
  ob_host_title_checking: '② Native Messaging host: checking…',
  ob_host_title_fail: '② Native Messaging host is not installed',
  ob_host_body: 'Required so the agent can save web pages and screenshots to your local disk.',
  ob_host_ext_id: 'Your extension ID:',
  ob_host_ext_id_loading: 'loading…',
  ob_host_after_install: 'After running, reload the extension on chrome://extensions, then come back here and click "Done — recheck".',
  ob_host_error_prefix: 'Error: ',
  ob_provider_title_checking: '③ Provider / model: checking…',
  ob_provider_title_fail: '③ Provider / model is not configured',
  ob_provider_body_checking: 'Checking backend config, OAuth login status, or local API key / base URL.',
  ob_provider_body_fail: 'Use backend defaults, OAuth login, or save an API key / base URL locally; pick Auto to use the backend default.',
  ob_open_settings: 'Open ⚙ settings',

  // History panel
  history_title: 'History',
  history_empty: 'No history in this group yet',
  history_count_suffix: '',

  // Settings panel
  settings_title: 'Model settings',
  settings_close: 'Close settings',
  settings_model_id: 'Model ID',
  settings_model_id_placeholder_auto: 'Hermes backend default',
  settings_local_note: 'Recommended: keep keys on the Hermes backend. Anything you fill here is stored only in Chrome local storage and sent only to 127.0.0.1.',
  settings_api_key: 'API Key',
  settings_apikey_placeholder_auto: 'Auto uses backend config',
  settings_apikey_placeholder_default: 'Optional: override backend API Key',
  settings_base_url: 'Base URL',
  settings_baseurl_placeholder_auto: 'Auto uses backend config',
  settings_baseurl_placeholder_default: 'Optional: custom OpenAI-compatible endpoint',
  settings_status_auto: 'Backend default',
  settings_status_local_override: 'Local override saved',
  settings_status_backend_cred: 'Using backend credential',
  settings_clear: 'Clear',
  settings_save: 'Save',
  settings_section_status: 'Connection status',
  settings_section_actions: 'Actions',
  settings_querying: 'Querying…',
  settings_no_status: 'Not queried yet — click Test connection or Log in.',
  settings_refresh: 'Refresh',
  settings_test_conn: 'Test connection',
  settings_login_with: 'Log in to {provider}',
  settings_logout: 'Log out',
  settings_finish_login: 'Finish login',
  settings_device_code: 'Device code',
  settings_oauth_hint: 'Will auto-detect once you authorize in the browser.',
  settings_cancel: 'Cancel',

  // Provider banner
  banner_backend_offline: 'Backend offline',
  banner_backend_offline_hint: 'Run `npm run backend:ensure` in the project directory to detect and start the local Hermes gateway.',
  banner_provider_checking: 'Checking provider configuration…',
  banner_provider_checking_hint: 'Verifying whether {provider} is available.',
  banner_provider_not_ready: 'Not ready',
  banner_copy_cmd: 'Copy command',
  banner_recheck: 'Recheck',
  banner_open_settings: 'Open settings',
  banner_provider_not_set: 'Not configured: {provider}. Open ⚙ in the top right to set an API key or log in.',
  banner_provider_status_failed: 'Could not query provider status',
  banner_send_failed: 'Send failed',
  banner_send_failed_hint: 'Send failed.',
  banner_login_failed: 'Could not start login',
  banner_login_failed_hint: 'Could not start login.',
  banner_login_incomplete: 'Login not completed',
  banner_login_success: 'Logged in.',
  banner_status_query_failed: 'Status query failed',
  banner_validate_failed: 'Validation failed',
  banner_logout_failed: 'Logout failed',
  banner_running_switch_confirm: 'A task is still running. Switch to a new chat anyway?',

  // Approval
  approval_want_run: 'wants to run',
  approval_allowed: 'Allowed',
  approval_denied: 'Denied',
  approval_allow: 'Allow',
  approval_deny: 'Deny',

  // Input / feed
  input_placeholder: 'Tell Hermes what to do, e.g. "Find the latest Sonnet 4 paper, list three sources".',
  input_send: 'Send',
  input_stop: 'Stop',
  feed_you: 'You',
  feed_dialog: 'Conversation',
  feed_step: 'step',
  feed_thinking_segments: '{n} thinking segments',
  feed_tool_count: '{n} tools',
  feed_tool_count_with_err: '{n} tools (with errors)',
  feed_reply_segments: '{n} intermediate replies',
  feed_process_label: 'Process ({n})',
  feed_new_message: 'New message',
  feed_collapse: 'Collapse',
  feed_expand: 'Expand',
  feed_tool_running: 'tool running',
  feed_tool_break: 'tool group breaks AI continuity',
  feed_approval: 'approval',

  // Exec mode
  mode_auto: 'Auto (Accept edits)',
  mode_auto_short: 'Auto',
  mode_plan: 'Plan mode (read-only research)',
  mode_plan_short: 'Plan',

  // CopyBtn
  copy_done: 'Copied',
  copy_do: 'Copy',
};

const DICTS: Record<Lang, Dict> = { zh: ZH, en: EN };

interface LangCtx {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LangCtx | null>(null);

function detectDefaultLang(): Lang {
  try {
    const ui = chrome.i18n.getUILanguage();
    return ui && ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectDefaultLang());
  useEffect(() => {
    chrome.storage.local
      .get(LANG_STORAGE_KEY)
      .then((r) => {
        const v = r[LANG_STORAGE_KEY];
        if (v === 'zh' || v === 'en') setLangState(v);
      })
      .catch(() => {});
  }, []);
  const value = useMemo<LangCtx>(() => {
    const setLang = (l: Lang) => {
      setLangState(l);
      chrome.storage.local.set({ [LANG_STORAGE_KEY]: l }).catch(() => {});
    };
    return {
      lang,
      setLang,
      toggleLang: () => setLang(lang === 'zh' ? 'en' : 'zh'),
      t: (key, vars) => interpolate(DICTS[lang][key] ?? key, vars),
    };
  }, [lang]);
  return createElement(LanguageContext.Provider, { value }, children);
}

export function useT(): LangCtx {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useT must be used within LanguageProvider');
  return ctx;
}
