import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import type { ProviderRequest, ProviderStatus, SidepanelMessage, SwToSidepanelMessage, UserSettings } from '../types/messages';
import { HISTORY_STORAGE_KEY, type Entry, type StoredConversation, type StoredConversationMap } from '../types/history';

marked.setOptions({ breaks: true, gfm: true });

function renderMd(text: string): { __html: string } {
  try {
    return { __html: marked.parse(text, { async: false }) as string };
  } catch {
    return { __html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  }
}

type ExecMode = 'auto' | 'approval' | 'plan';

type ModelOption = { value: string; label: string; short: string };
type ProviderOption = {
  value: string;
  label: string;
  short: string;
  description: string;
  authType: 'api_key' | 'oauth' | 'custom' | 'backend_config';
  requiredFields?: Array<'apiKey' | 'baseUrl' | 'model'>;
  setupHint: string;
  models: ModelOption[];
};
type ProviderCredential = { apiKey?: string; baseUrl?: string };
type ProviderCredentialStore = Record<string, ProviderCredential>;

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'auto',
    label: 'Auto / Hermes 默认配置',
    short: 'AUTO',
    description: '使用 Hermes 后端当前 model.provider / model.default 配置。',
    authType: 'backend_config',
    setupHint: 'Auto 使用 Hermes 后端当前默认配置。',
    models: [{ value: '', label: 'Hermes backend default', short: 'Default' }],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    short: 'DS',
    description: 'DeepSeek 官方 API。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 DeepSeek API Key，或在后端配置 DEEPSEEK_API_KEY。',
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', short: 'Chat' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', short: 'Reasoner' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（兼容旧会话）', short: 'V4F' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（兼容旧会话）', short: 'V4P' },
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude',
    short: 'CLAUDE',
    description: 'Anthropic Messages API。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 Anthropic API Key。没有 Anthropic Key 时，建议改用 OpenAI Codex OAuth 或 Custom（OpenRouter Base URL）。',
    models: [
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', short: 'Opus 4.7' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', short: 'Sonnet 4.6' },
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', short: 'Opus 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', short: 'Haiku 4.5' },
    ],
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    short: 'GEM',
    description: 'Google AI Studio API key provider。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 Google AI Studio API Key，或在后端配置 GOOGLE_API_KEY/GEMINI_API_KEY。',
    models: [
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', short: '3F' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', short: '3P' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', short: '3.1P' },
    ],
  },
  {
    value: 'xai',
    label: 'xAI Grok',
    short: 'xAI',
    description: 'xAI 官方 API。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 xAI API Key，或在后端配置 XAI_API_KEY。',
    models: [
      { value: 'grok-4', label: 'Grok 4', short: 'Grok4' },
      { value: 'grok-code-fast-1', label: 'Grok Code Fast 1', short: 'Code' },
      { value: 'grok-4-fast', label: 'Grok 4 Fast', short: 'Fast' },
    ],
  },
  {
    value: 'alibaba',
    label: 'Qwen / Alibaba',
    short: 'QWEN',
    description: 'Alibaba DashScope OpenAI-compatible API。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 DashScope API Key，或在后端配置 DASHSCOPE_API_KEY。',
    models: [
      { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus', short: '3.6+' },
      { value: 'qwen3.5-plus', label: 'Qwen3.5 Plus', short: '3.5+' },
      { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', short: 'Coder' },
    ],
  },
  {
    value: 'qwen-oauth',
    label: 'Qwen OAuth',
    short: 'QOAuth',
    description: 'Qwen CLI / Portal OAuth provider。',
    authType: 'oauth',
    setupHint: '使用 Qwen OAuth。通常需要先在本机完成 qwen auth qwen-oauth。',
    models: [
      { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus', short: '3.6+' },
      { value: 'qwen3.5-plus', label: 'Qwen3.5 Plus', short: '3.5+' },
      { value: 'qwen3-coder-next', label: 'Qwen3 Coder Next', short: 'Next' },
    ],
  },
  {
    value: 'kimi-coding',
    label: 'Kimi / Moonshot',
    short: 'KIMI',
    description: 'Kimi / Moonshot coding provider。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 Kimi/Moonshot API Key，或在后端配置 KIMI_API_KEY。',
    models: [
      { value: 'kimi-k2.6', label: 'Kimi K2.6', short: 'K2.6' },
      { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', short: 'Think' },
      { value: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo Preview', short: 'Turbo' },
    ],
  },
  {
    value: 'zai',
    label: 'Z.ai / GLM',
    short: 'GLM',
    description: 'Z.ai / Zhipu GLM provider。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 Z.ai/GLM API Key，或在后端配置 GLM_API_KEY/ZAI_API_KEY。',
    models: [
      { value: 'glm-5.1', label: 'GLM 5.1', short: '5.1' },
      { value: 'glm-5', label: 'GLM 5', short: '5' },
      { value: 'glm-5-turbo', label: 'GLM 5 Turbo', short: 'Turbo' },
    ],
  },
  {
    value: 'minimax',
    label: 'MiniMax',
    short: 'MM',
    description: 'MiniMax Anthropic-compatible provider。',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: '粘贴 MiniMax API Key，或选择 MiniMax OAuth 登录。',
    models: [
      { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', short: 'M2.7' },
      { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', short: 'M2.5' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', short: 'Fast' },
    ],
  },
  {
    value: 'custom',
    label: 'Custom / Local',
    short: 'CUSTOM',
    description: 'OpenAI-compatible custom endpoint, local Ollama/vLLM/LM Studio 等。',
    authType: 'custom',
    requiredFields: ['baseUrl', 'model'],
    setupHint: '填写 OpenAI-compatible Base URL 和 Model ID；API Key 可选。',
    models: [{ value: '', label: '输入自定义 Model ID', short: 'Custom' }],
  },
  {
    value: 'openai-codex',
    label: 'OpenAI Codex OAuth',
    short: 'CODEX',
    description: 'OpenAI Codex 登录链接 / device-code provider。',
    authType: 'oauth',
    setupHint: '通过 OpenAI Codex OAuth 登录，不需要 API Key。',
    models: [
      { value: 'gpt-5.5', label: 'GPT-5.5', short: '5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4', short: '5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', short: '5.4M' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', short: '5.3C' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', short: '5.2C' },
      { value: 'gpt-5.2', label: 'GPT-5.2', short: '5.2' },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', short: '5.1CM' },
      { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', short: '5.1Cm' },
    ],
  },
  {
    value: 'google-gemini-cli',
    label: 'Gemini OAuth',
    short: 'GEM OAuth',
    description: 'Google Gemini CLI / Cloud Code OAuth provider。',
    authType: 'oauth',
    setupHint: '使用 Google Gemini OAuth；通常需要本机完成 Gemini CLI 登录。',
    models: [
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', short: '3F' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', short: '3P' },
    ],
  },
  {
    value: 'minimax-oauth',
    label: 'MiniMax OAuth',
    short: 'MM OAuth',
    description: 'MiniMax OAuth 登录 provider。',
    authType: 'oauth',
    setupHint: '通过 MiniMax OAuth 登录，不需要 API Key。',
    models: [
      { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', short: 'M2.7' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', short: 'Fast' },
    ],
  },
  {
    value: 'nous',
    label: 'Nous Portal OAuth',
    short: 'NOUS',
    description: 'Nous Portal device-code OAuth provider。',
    authType: 'oauth',
    setupHint: '通过 Nous Portal 登录，不需要 API Key。',
    models: [
      { value: '', label: 'Nous default model', short: 'Default' },
    ],
  },
];
const MODE_OPTIONS: { value: ExecMode; label: string; short: string; icon: string }[] = [
  { value: 'auto',     label: '自动执行（Accept edits）', short: '自动',  icon: '🤖' },
  { value: 'plan',     label: 'Plan 模式（只读调研）',    short: 'Plan',  icon: '📋' },
];
const PLACEHOLDER_BY_MODE: Record<string, string> = {
  auto: 'Ask Hermes...  (⌘↩)',
  plan: 'Plan 模式 · 只调研不操作  (⌘↩)',
};
const DEFAULT_SETTINGS: UserSettings = { provider: 'auto', model: '', mode: 'auto' };
const CREDENTIAL_STORAGE_KEY = 'hermes_provider_credentials_v1';
const settingsBySession: Record<string, UserSettings> = {};

const entriesBySession: Record<string, Entry[]> = {};
const runningBySession: Record<string, boolean> = {};
const groupBySession: Record<string, number | null> = {};

type HistoryItem = {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
};

function providerByValue(value?: string): ProviderOption {
  return PROVIDER_OPTIONS.find((p) => p.value === value) || PROVIDER_OPTIONS[0];
}

function inferProviderFromModel(model?: string): string {
  if (!model) return 'auto';
  for (const provider of PROVIDER_OPTIONS) {
    if (provider.value === 'auto' || provider.value === 'custom') continue;
    if (provider.models.some((m) => m.value === model)) return provider.value;
  }
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('grok-')) return 'xai';
  if (model.startsWith('qwen')) return 'alibaba';
  if (model.startsWith('kimi-')) return 'kimi-coding';
  if (model.startsWith('glm-')) return 'zai';
  if (model.startsWith('MiniMax-')) return 'minimax';
  if (model.includes('/')) return 'openrouter';
  return 'custom';
}

function defaultModelForProvider(providerValue?: string): string {
  return providerByValue(providerValue).models[0]?.value || '';
}

function normalizeSettings(raw?: UserSettings): UserSettings {
  const provider = raw?.provider || inferProviderFromModel(raw?.model);
  const model = raw?.model ?? defaultModelForProvider(provider);
  const requestedMode = raw?.mode || (raw?.require_approval ? 'auto' : 'auto');
  const mode = requestedMode === 'plan' ? 'plan' : 'auto';
  return {
    provider,
    model: provider === 'auto' ? (model || '') : model,
    mode,
    require_approval: raw?.require_approval,
  };
}

function storageSettings(raw?: UserSettings): UserSettings {
  const normalized = normalizeSettings(raw);
  const persistable = { ...normalized };
  delete persistable.credentialOverride;
  return persistable;
}

function shortModelLabel(model: string): string {
  if (!model) return 'Default';
  return model.length > 14 ? `${model.slice(0, 13)}…` : model;
}

async function readCredentials(): Promise<ProviderCredentialStore> {
  const stored = await chrome.storage.local.get(CREDENTIAL_STORAGE_KEY);
  return (stored[CREDENTIAL_STORAGE_KEY] as ProviderCredentialStore | undefined) || {};
}

async function writeCredentials(credentials: ProviderCredentialStore): Promise<void> {
  await chrome.storage.local.set({ [CREDENTIAL_STORAGE_KEY]: credentials });
}

async function readConversations(): Promise<StoredConversationMap> {
  const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  return (stored[HISTORY_STORAGE_KEY] as StoredConversationMap | undefined) || {};
}

async function writeConversations(conversations: StoredConversationMap): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: conversations });
}

function historyTitle(entries: Entry[], fallback: string, existing?: string): string {
  const firstUser = entries.find((e) => e.kind === 'user');
  const raw = firstUser?.kind === 'user' ? firstUser.text : existing || fallback || '新对话';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 56) || '新对话';
}

async function persistSession(
  sessionId: string,
  entries: Entry[],
  options: { settings?: UserSettings; groupId?: number | null; titleFallback?: string } = {},
): Promise<void> {
  const conversations = await readConversations();
  const existing = conversations[sessionId];
  const groupId = options.groupId !== undefined ? options.groupId : groupBySession[sessionId] ?? existing?.groupId ?? null;
  groupBySession[sessionId] = groupId;
  const settings = storageSettings(options.settings || settingsBySession[sessionId] || existing?.settings || DEFAULT_SETTINGS);
  conversations[sessionId] = {
    id: sessionId,
    groupId,
    title: historyTitle(entries, options.titleFallback || '', existing?.title),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    entries,
    settings,
  };
  await writeConversations(conversations);
}

function buildMarkdownExport(entries: Entry[]): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [`# Hermes 对话 · ${stamp}`, ''];
  for (const e of entries) {
    if (e.kind === 'user') {
      lines.push(`## 🙋 你`, '', e.text, '');
    } else if (e.kind === 'thinking') {
      lines.push(`> 💭 ${e.text}`, '');
    } else if (e.kind === 'text') {
      lines.push(`## 🦁 Hermes`, '', e.text, '');
    } else if (e.kind === 'tool') {
      const args = JSON.stringify(e.args);
      const status = e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '…';
      lines.push(`- \`${e.tool}\` ${args.slice(0, 200)} ${status}${e.status === 'error' ? ` — ${e.error}` : ''}`);
    } else if (e.kind === 'approval') {
      lines.push(`- 🔐 审批 \`${e.tool}\` · ${e.status}`);
    }
  }
  return lines.join('\n');
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shortArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch {
    return '';
  }
}

function BgLayers() {
  return (
    <>
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-vignette" aria-hidden="true" />
      <div className="bg-sun" aria-hidden="true" />
      <div className="bg-floor" aria-hidden="true" />
      <div className="bg-scan" aria-hidden="true" />
      <div className="corner-mark tl" aria-hidden="true" />
      <div className="corner-mark tr" aria-hidden="true" />
      <div className="corner-mark bl" aria-hidden="true" />
      <div className="corner-mark br" aria-hidden="true" />
      <div className="neon-frame" aria-hidden="true">
        <div className="neon-bar top" />
        <div className="neon-bar right" />
        <div className="neon-bar bottom" />
        <div className="neon-bar left" />
      </div>
    </>
  );
}

function Avatar({ small = false, showId = false }: { small?: boolean; showId?: boolean }) {
  return (
    <div className={`avatar ${small ? 'small' : ''}`}>
      <div className="layer base" />
      <div className="layer ghost-cyan" />
      <div className="layer ghost-pink" />
      <div className="layer scanlines" />
      <div className="layer flash" />
      {showId && <span className="id">H</span>}
      <span className="pix" />
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`copy-btn ${copied ? 'copied' : ''}`}
      title={copied ? '已复制' : '复制'}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

type Theme = 'dystopia' | 'synthwave';
const THEME_STORAGE_KEY = 'hermes_theme';

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState<Theme>('dystopia');
  useEffect(() => {
    chrome.storage.local.get(THEME_STORAGE_KEY).then((r) => {
      const v = r[THEME_STORAGE_KEY];
      if (v === 'synthwave' || v === 'dystopia') setTheme(v);
    }).catch(() => {});
  }, []);
  function toggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === 'dystopia' ? 'synthwave' : 'dystopia';
      chrome.storage.local.set({ [THEME_STORAGE_KEY]: next }).catch(() => {});
      return next;
    });
  }
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentGroupId, setCurrentGroupId] = useState<number | null>(null);
  const [currentTabTitle, setCurrentTabTitle] = useState<string>('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<UserSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [oauthSession, setOauthSession] = useState<{ provider: string; loginUrl?: string; userCode?: string; sessionId?: string; pollInterval?: number } | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [startupChecking, setStartupChecking] = useState(false);
  const [providerBanner, setProviderBanner] = useState<string | null>(null);
  const oauthPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupCheckKeyRef = useRef('');
  const [credentials, setCredentials] = useState<ProviderCredentialStore>({});
  const credentialsRef = useRef<ProviderCredentialStore>({});
  const [credentialDraft, setCredentialDraft] = useState<ProviderCredential>({});
  const composingRef = useRef(false);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { credentialsRef.current = credentials; }, [credentials]);
  useEffect(() => {
    readCredentials().then(setCredentials).catch(() => {});
  }, []);
  useEffect(() => {
    const provider = settings.provider || 'auto';
    setCredentialDraft(credentials[provider] || {});
  }, [settings.provider, credentials]);
  const currentGroupIdRef = useRef<number | null>(null);
  useEffect(() => { currentGroupIdRef.current = currentGroupId; }, [currentGroupId]);

  async function refreshHistory(groupId = currentGroupIdRef.current) {
    const conversations = await readConversations();
    const items = Object.values(conversations)
      .filter((c) => groupId == null || c.groupId === groupId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.entries.length }));
    setHistoryItems(items);
  }

  function applyStoredConversation(conversation: StoredConversation, groupId: number | null) {
    const normalizedSettings = storageSettings(conversation.settings || DEFAULT_SETTINGS);
    groupBySession[conversation.id] = groupId;
    entriesBySession[conversation.id] = conversation.entries;
    settingsBySession[conversation.id] = normalizedSettings;
    setCurrentSessionId(conversation.id);
    setCurrentGroupId(groupId);
    setEntries(conversation.entries);
    setSettings(normalizedSettings);
    setRunning(!!runningBySession[conversation.id]);
  }

  async function loadSession(sessionId: string, groupId: number | null, fallbackTitle = currentTabTitle) {
    const conversations = await readConversations();
    const stored = conversations[sessionId];
    if (stored) {
      applyStoredConversation(stored, groupId ?? stored.groupId ?? null);
      return;
    }
    groupBySession[sessionId] = groupId;
    entriesBySession[sessionId] = entriesBySession[sessionId] || [];
    settingsBySession[sessionId] = settingsBySession[sessionId] || DEFAULT_SETTINGS;
    await persistSession(sessionId, entriesBySession[sessionId], { groupId, settings: settingsBySession[sessionId], titleFallback: fallbackTitle });
    setCurrentSessionId(sessionId);
    setCurrentGroupId(groupId);
    setEntries(entriesBySession[sessionId]);
    setSettings(storageSettings(settingsBySession[sessionId]));
    setRunning(!!runningBySession[sessionId]);
  }

  useEffect(() => {
    if (!currentSessionId) {
      setSettings(DEFAULT_SETTINGS);
      return;
    }
    setSettings(storageSettings(settingsBySession[currentSessionId] || DEFAULT_SETTINGS));
  }, [currentSessionId]);

  function updateSettings(patch: Partial<UserSettings>) {
    setSettings((prev) => {
      const next = storageSettings({ ...prev, ...patch });
      if (currentSessionId) {
        settingsBySession[currentSessionId] = next;
        const snapshot = entriesBySession[currentSessionId] || entries;
        persistSession(currentSessionId, snapshot, { settings: next, groupId: currentGroupIdRef.current, titleFallback: currentTabTitle }).catch(() => {});
      }
      return next;
    });
  }

  function updateProvider(provider: string) {
    updateSettings({ provider, model: defaultModelForProvider(provider) });
  }

  function buildSubmitSettings(base: UserSettings): UserSettings {
    const normalized = storageSettings(base);
    const provider = normalized.provider || 'auto';
    const credential = provider === 'auto' ? undefined : credentialsRef.current[provider];
    const apiKey = credential?.apiKey?.trim();
    const baseUrl = credential?.baseUrl?.trim();
    if (!apiKey && !baseUrl) return normalized;
    return {
      ...normalized,
      credentialOverride: {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
  }

  async function saveCredentialDraft() {
    const provider = settings.provider || 'auto';
    if (provider === 'auto') return;
    const cleaned: ProviderCredential = {
      apiKey: credentialDraft.apiKey?.trim() || undefined,
      baseUrl: credentialDraft.baseUrl?.trim() || undefined,
    };
    const next = { ...credentials };
    if (cleaned.apiKey || cleaned.baseUrl) next[provider] = cleaned;
    else delete next[provider];
    setCredentials(next);
    await writeCredentials(next);
  }

  async function clearCredentialDraft() {
    const provider = settings.provider || 'auto';
    if (provider === 'auto') return;
    const next = { ...credentials };
    delete next[provider];
    setCredentials(next);
    setCredentialDraft({});
    await writeCredentials(next);
  }

  function buildProviderRequest(extra?: Partial<ProviderRequest>): ProviderRequest {
    const provider = settings.provider || 'auto';
    const credential = credentials[provider];
    const apiKey = credentialDraft.apiKey?.trim() || credential?.apiKey?.trim();
    const baseUrl = credentialDraft.baseUrl?.trim() || credential?.baseUrl?.trim();
    return {
      provider,
      model: settings.model,
      ...(apiKey || baseUrl
        ? { credentialOverride: { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) } }
        : {}),
      ...(extra || {}),
    };
  }

  async function refreshProviderStatus(options: { silent?: boolean } = {}) {
    if (options.silent) setStartupChecking(true);
    else setProviderBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_STATUS',
        request: buildProviderRequest(),
      } satisfies SidepanelMessage);
      if (resp?.status) setProviderStatus(resp.status);
    } catch (e) {
      setProviderStatus({
        provider: settings.provider || 'auto',
        ok: false, connected: false,
        message: `状态查询失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      if (options.silent) setStartupChecking(false);
      else setProviderBusy(false);
    }
  }

  async function validateProvider() {
    setProviderBusy(true);
    setProviderBanner(null);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_VALIDATE',
        request: buildProviderRequest(),
      } satisfies SidepanelMessage);
      if (resp?.status) setProviderStatus(resp.status);
    } catch (e) {
      setProviderBanner(`验证失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProviderBusy(false);
    }
  }

  function stopOauthPoll() {
    if (oauthPollTimerRef.current) {
      clearTimeout(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
  }

  function schedulePoll(provider: string, sessionId: string, intervalSec: number) {
    stopOauthPoll();
    oauthPollTimerRef.current = setTimeout(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'SP_PROVIDER_AUTH_POLL',
          request: { provider, sessionId },
        } satisfies SidepanelMessage);
        const status = resp?.status as ProviderStatus | undefined;
        if (!status) {
          schedulePoll(provider, sessionId, intervalSec);
          return;
        }
        if (status.ok) {
          setProviderStatus(status);
          setOauthSession(null);
          setProviderBanner('登录成功。');
          stopOauthPoll();
          return;
        }
        if (status.message && /expired|denied|error/i.test(status.message)) {
          setProviderBanner(`登录未完成: ${status.message}`);
          setOauthSession(null);
          stopOauthPoll();
          return;
        }
        schedulePoll(provider, sessionId, intervalSec);
      } catch {
        schedulePoll(provider, sessionId, intervalSec);
      }
    }, Math.max(2, intervalSec) * 1000);
  }

  async function startProviderAuth() {
    setProviderBusy(true);
    setProviderBanner(null);
    try {
      const provider = settings.provider || 'auto';
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_AUTH_START',
        request: buildProviderRequest(),
      } satisfies SidepanelMessage);
      const status = resp?.status as ProviderStatus | undefined;
      if (status?.ok && status.sessionId) {
        setOauthSession({
          provider,
          loginUrl: status.loginUrl,
          userCode: status.userCode,
          sessionId: status.sessionId,
          pollInterval: status.pollInterval || 5,
        });
        setProviderStatus(status);
        if (status.loginUrl) {
          try { window.open(status.loginUrl, '_blank', 'noopener'); } catch {}
        }
        schedulePoll(provider, status.sessionId, status.pollInterval || 5);
      } else {
        setProviderBanner(status?.message || '启动登录失败。');
      }
    } catch (e) {
      setProviderBanner(`启动登录失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProviderBusy(false);
    }
  }

  async function logoutProvider() {
    setProviderBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_LOGOUT',
        request: buildProviderRequest(),
      } satisfies SidepanelMessage);
      if (resp?.status) setProviderStatus(resp.status);
      setOauthSession(null);
      stopOauthPoll();
    } catch (e) {
      setProviderBanner(`登出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProviderBusy(false);
    }
  }

  // 切换 provider 或打开 settings 时自动查一次状态
  useEffect(() => {
    if (!settingsOpen) return;
    refreshProviderStatus().catch(() => {});
    // 切换 provider 时取消上一个 OAuth poll
    return () => stopOauthPoll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, settings.provider]);

  useEffect(() => {
    if (!connected) {
      startupCheckKeyRef.current = '';
      return;
    }
    const provider = settings.provider || 'auto';
    const credential = credentials[provider];
    const key = `${provider}:${settings.model || ''}:${credential?.apiKey ? 'key' : ''}:${credential?.baseUrl || ''}`;
    if (startupCheckKeyRef.current === key) return;
    startupCheckKeyRef.current = key;
    refreshProviderStatus({ silent: true }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, settings.provider, settings.model, credentials]);

  function approveCall(id: string, approved: boolean, session_id: string) {
    chrome.runtime.sendMessage({ type: 'SP_TOOL_APPROVAL', id, approved, session_id } satisfies SidepanelMessage).catch(() => {});
    const prev = entriesBySession[session_id] || [];
    const next = prev.map((e) => {
      if (e.kind === 'approval' && e.id === id && e.status === 'pending') {
        return { ...e, status: approved ? ('approved' as const) : ('denied' as const) };
      }
      return e;
    });
    entriesBySession[session_id] = next;
    persistSession(session_id, next, { groupId: groupBySession[session_id] ?? currentGroupIdRef.current, titleFallback: currentTabTitle }).catch(() => {});
    if (currentSessionIdRef.current === session_id) setEntries(next);
  }
  const followingRef = useRef(true);
  useEffect(() => { followingRef.current = following; }, [following]);
  const currentSessionIdRef = useRef<string | null>(null);
  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);

  function onUserScroll() {
    requestAnimationFrame(() => {
      const el = feedRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      setFollowing(atBottom);
      if (atBottom) setHasNew(false);
    });
  }

  function jumpToBottom() {
    const el = feedRef.current;
    if (!el) return;
    setFollowing(true);
    setHasNew(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  useEffect(() => {
    let cancelled = false;
    async function syncToActiveTab() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (cancelled || tab?.id == null) return;
        setCurrentTabTitle(tab.title || tab.url || '');
        const resp = await chrome.runtime.sendMessage({ type: 'SP_SWITCH_TAB', tabId: tab.id } satisfies SidepanelMessage);
        const newSid: string | null = resp?.sessionId || null;
        const newGroupId = typeof resp?.groupId === 'number' ? resp.groupId : null;
        setCurrentGroupId(newGroupId);
        if (newSid) {
          groupBySession[newSid] = newGroupId;
          await loadSession(newSid, newGroupId, tab.title || tab.url || '');
        } else {
          setCurrentSessionId(null);
          setEntries([]);
          setRunning(false);
        }
        await refreshHistory(newGroupId);
      } catch {}
    }
    syncToActiveTab();
    const onActivated = () => syncToActiveTab();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === 'complete' || info.title) syncToActiveTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    const onMsg = (msg: SwToSidepanelMessage) => {
      const sid = (msg as any).session_id as string | undefined;
      if (!sid) return;

      const prev = entriesBySession[sid] || [];
      const next = [...prev];
      if (msg.type === 'SW_DELTA') {
        const last = next[next.length - 1];
        const kind = msg.channel;
        if (last && last.kind === kind) {
          next[next.length - 1] = { ...last, text: last.text + msg.text };
        } else {
          next.push({ kind, text: msg.text });
        }
      } else if (msg.type === 'SW_TOOL_CALL') {
        next.push({ kind: 'tool', tool: msg.tool, args: msg.args, status: 'pending' });
      } else if (msg.type === 'SW_TOOL_APPROVAL_REQUEST') {
        next.push({ kind: 'approval', id: msg.id, tool: msg.tool, args: msg.args, status: 'pending', session_id: msg.session_id });
      } else if (msg.type === 'SW_TOOL_RESULT') {
        for (let i = next.length - 1; i >= 0; i--) {
          const e = next[i];
          if (e.kind === 'tool' && e.status === 'pending') {
            next[i] = { ...e, status: msg.ok ? 'ok' : 'error', result: msg.data, error: msg.error };
            break;
          }
        }
      } else if (msg.type === 'SW_COMPLETE') {
        runningBySession[sid] = false;
        if (currentSessionIdRef.current === sid) setRunning(false);
      } else if (msg.type === 'SW_ERROR') {
        next.push({ kind: 'text', text: `❌ ${msg.error}` });
        runningBySession[sid] = false;
        if (currentSessionIdRef.current === sid) setRunning(false);
      } else {
        return;
      }
      entriesBySession[sid] = next;
      persistSession(sid, next, { groupId: groupBySession[sid] ?? currentGroupIdRef.current, titleFallback: currentTabTitle }).catch(() => {});
      if (currentSessionIdRef.current === sid) {
        setEntries(next);
        refreshHistory(groupBySession[sid] ?? currentGroupIdRef.current).catch(() => {});
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    const tick = async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SP_GET_STATUS' } satisfies SidepanelMessage);
        setConnected(!!res?.connected);
        if (typeof res?.groupId === 'number') setCurrentGroupId(res.groupId);
      } catch { setConnected(false); }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (followingRef.current) {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
    } else if (entries.length > 0) {
      setHasNew(true);
    }
  }, [entries]);

  async function submit() {
    const text = draft.trim();
    if (!text || running) return;

    // 发送前的 connected 检查：未连接时 block 并提示打开配置
    const provider = settings.provider || 'auto';
    if (provider !== 'auto' && provider !== 'custom') {
      const cred = credentials[provider];
      const hasLocalKey = !!(cred?.apiKey || cred?.baseUrl);
      const knownConnected = providerStatus && providerStatus.provider === provider && providerStatus.ok;
      if (!hasLocalKey && !knownConnected) {
        // 主动查一次，避免冷启动空值
        try {
          const resp = await chrome.runtime.sendMessage({
            type: 'SP_PROVIDER_STATUS',
            request: { provider, model: settings.model },
          } satisfies SidepanelMessage);
          const s = resp?.status as ProviderStatus | undefined;
          if (s) setProviderStatus(s);
          if (!s?.ok) {
            setProviderBanner(`${providerByValue(provider).label} 未配置：${s?.message || s?.hint || '请打开右上角 ⚙ 配置 API Key 或登录。'}`);
            setSettingsOpen(true);
            return;
          }
        } catch (e) {
          setProviderBanner(`无法查询 provider 状态: ${e instanceof Error ? e.message : String(e)}`);
          setSettingsOpen(true);
          return;
        }
      }
    }

    setFollowing(true);
    setHasNew(false);
    let submittedEntries: Entry[] = [];
    setEntries((prev) => {
      const next = [...prev, { kind: 'user' as const, text }];
      submittedEntries = next;
      if (currentSessionId) {
        entriesBySession[currentSessionId] = next;
        persistSession(currentSessionId, next, { groupId: currentGroupIdRef.current, titleFallback: currentTabTitle }).catch(() => {});
      }
      return next;
    });
    setDraft('');
    setRunning(true);
    try {
      const submittedSettings = buildSubmitSettings(settingsRef.current);
      const persistedSettings = storageSettings(settingsRef.current);
      const resp = await chrome.runtime.sendMessage({ type: 'SP_SUBMIT', text, settings: submittedSettings } satisfies SidepanelMessage);
      if (resp && resp.ok === false) {
        setEntries((prev) => {
          const next = [...prev, { kind: 'text' as const, text: `❌ ${resp.error || '发送失败'}` }];
          if (currentSessionId) {
            entriesBySession[currentSessionId] = next;
            persistSession(currentSessionId, next, { groupId: currentGroupIdRef.current, titleFallback: currentTabTitle }).catch(() => {});
          }
          return next;
        });
        setRunning(false);
      } else if (resp?.session) {
        const newSid = resp.session as string;
        const newGroupId = typeof resp.groupId === 'number' ? resp.groupId : currentGroupIdRef.current;
        if (newSid !== currentSessionId) {
          entriesBySession[newSid] = currentSessionId ? (entriesBySession[currentSessionId] || submittedEntries) : submittedEntries;
          setCurrentSessionId(newSid);
        }
        groupBySession[newSid] = newGroupId;
        settingsBySession[newSid] = persistedSettings;
        setCurrentGroupId(newGroupId);
        runningBySession[newSid] = true;
        persistSession(newSid, entriesBySession[newSid] || submittedEntries, { groupId: newGroupId, settings: persistedSettings, titleFallback: currentTabTitle }).catch(() => {});
        refreshHistory(newGroupId).catch(() => {});
      }
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'text', text: `❌ 发送失败: ${e instanceof Error ? e.message : String(e)}` }]);
      setRunning(false);
    }
  }

  async function stop() {
    await chrome.runtime.sendMessage({ type: 'SP_STOP' } satisfies SidepanelMessage);
    if (currentSessionId) runningBySession[currentSessionId] = false;
    setRunning(false);
  }

  async function newChat() {
    if (running && !confirm('当前任务仍在运行，要切到新对话吗？')) return;
    if (currentSessionId) {
      await persistSession(currentSessionId, entries, { groupId: currentGroupIdRef.current, settings, titleFallback: currentTabTitle });
    }
    const resp = await chrome.runtime.sendMessage({ type: 'SP_NEW_CHAT' } satisfies SidepanelMessage);
    if (resp?.ok === false || !resp?.sessionId) return;
    const newSid = resp.sessionId as string;
    const newGroupId = typeof resp.groupId === 'number' ? resp.groupId : currentGroupIdRef.current;
    entriesBySession[newSid] = [];
    settingsBySession[newSid] = DEFAULT_SETTINGS;
    groupBySession[newSid] = newGroupId;
    runningBySession[newSid] = false;
    setEntries([]);
    setSettings(DEFAULT_SETTINGS);
    setCurrentSessionId(newSid);
    setCurrentGroupId(newGroupId);
    setRunning(false);
    setFollowing(true);
    setHasNew(false);
    await persistSession(newSid, [], { groupId: newGroupId, settings: DEFAULT_SETTINGS, titleFallback: currentTabTitle });
    await refreshHistory(newGroupId);
  }

  async function selectHistory(sessionId: string) {
    const conversations = await readConversations();
    const conversation = conversations[sessionId];
    if (!conversation) return;
    const resp = await chrome.runtime.sendMessage({ type: 'SP_SELECT_SESSION', sessionId } satisfies SidepanelMessage);
    if (resp?.ok === false) return;
    const groupId = typeof resp?.groupId === 'number' ? resp.groupId : conversation.groupId ?? currentGroupIdRef.current;
    groupBySession[sessionId] = groupId;
    applyStoredConversation(conversation, groupId);
    setHistoryOpen(false);
    setFollowing(true);
    setHasNew(false);
    await refreshHistory(groupId);
  }

  function exportConversation() {
    if (entries.length === 0) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    downloadText(`hermes-${stamp}.md`, buildMarkdownExport(entries));
  }

  const placeholder = PLACEHOLDER_BY_MODE[settings.mode || 'auto'] || PLACEHOLDER_BY_MODE.auto;
  const currentMode = MODE_OPTIONS.find(o => o.value === (settings.mode || 'auto')) || MODE_OPTIONS[0];
  const currentProvider = providerByValue(settings.provider || 'auto');
  const currentModel = currentProvider.models.find(o => o.value === (settings.model || '')) || {
    value: settings.model || '',
    label: settings.model || currentProvider.models[0]?.label || 'Hermes backend default',
    short: shortModelLabel(settings.model || ''),
  };
  const modelSelectValue = currentProvider.models.some((m) => m.value === (settings.model || ''))
    ? (settings.model || '')
    : '__custom__';
  const providerHasCredential = !!credentials[currentProvider.value]?.apiKey || !!credentials[currentProvider.value]?.baseUrl;
  const statusForCurrentProvider = providerStatus?.provider === currentProvider.value ? providerStatus : null;
  const setupNotice = !connected
    ? {
        level: 'error' as const,
        title: 'Hermes 后端未连接',
        body: '在项目目录运行 npm run backend:ensure，脚本会检测并启动本地 Hermes gateway。',
        command: 'npm run backend:ensure',
      }
    : startupChecking
      ? {
          level: 'checking' as const,
          title: '正在检测模型配置',
          body: `正在检查 ${currentProvider.label} 是否可用。`,
          command: '',
        }
      : statusForCurrentProvider && !statusForCurrentProvider.ok
        ? {
            level: 'warn' as const,
            title: `${currentProvider.label} 未就绪`,
            body: statusForCurrentProvider.message || statusForCurrentProvider.hint || currentProvider.setupHint,
            command: currentProvider.value === 'auto' ? 'npm run backend:ensure' : '',
          }
        : null;

  const toolCount = entries.filter((e) => e.kind === 'tool').length;

  return (
    <div className="panel-wrap" data-theme={theme}>
      <div className="hazard-frame" aria-hidden="true">
        <div className="hzd-bar top" />
        <div className="hzd-bar right" />
        <div className="hzd-bar bottom" />
        <div className="hzd-bar left" />
      </div>
      <div className="panel">
        <BgLayers />
        <div className="content">
          <div className="header">
            <div className="logo">
              <div title={currentSessionId || ''}><Avatar /></div>
              <div className="logo-text">
                <div className="logo-name">HERMES</div>
                <div className="logo-sub">
                  {theme === 'synthwave' ? '// SYNTHWAVE_84' : 'Ἑρμῆς · ψυχοπομπός'}
                </div>
                <div className="logo-meta">
                  <span className="ver">v0.3</span>
                  <span className="sep">·</span>
                  <span className="model">{currentProvider.short}</span>
                  <span className="sep">/</span>
                  <span className="model">{currentModel.short}</span>
                  <span className="sep">·</span>
                  <span className={`status ${connected ? '' : 'offline'}`}><span className="dot" />{connected ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
              </div>
            </div>
            <div className="header-actions">
              <button className={`icon-btn ${settingsOpen ? 'active' : ''}`} title="模型与密钥设置" onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
              <button
                className="icon-btn theme-toggle"
                title={theme === 'dystopia' ? '切换到 Synthwave 80s' : '切换到 CP2077 主题'}
                onClick={toggleTheme}
              >{theme === 'dystopia' ? '◐' : '◑'}</button>
              <button className={`icon-btn ${historyOpen ? 'active' : ''}`} title="历史对话" onClick={() => { setHistoryOpen((v) => !v); refreshHistory().catch(() => {}); }}>◷</button>
              <button className="icon-btn" title="导出对话为 Markdown" onClick={exportConversation} disabled={entries.length === 0}>⤓</button>
              <button className="icon-btn" title="新对话" onClick={newChat}>+</button>
            </div>
          </div>
          <div className="system-bar" aria-hidden="true">
            <div className="hazard-mini" />
            <span>SYSTEM // OPERATIONAL · {toolCount} TOOLS</span>
          </div>
          <div className="tab-meta" title={currentTabTitle || ''}>
            <span className="tab-fav" />
            <span className="tab-url">{currentTabTitle || '—'}</span>
            <span className="tab-id">// TAB</span>
          </div>
      {historyOpen && (
        <div className="history-panel">
          <div className="history-head">
            <span>历史对话</span>
            <span>{historyItems.length}</span>
          </div>
          <div className="history-list">
            {historyItems.length === 0 && <div className="history-empty">这个组还没有历史</div>}
            {historyItems.map((item) => (
              <button
                key={item.id}
                className={`history-item ${item.id === currentSessionId ? 'current' : ''}`}
                onClick={() => selectHistory(item.id)}
                title={item.title}
              >
                <span className="history-title">{item.title}</span>
                <span className="history-meta">{new Date(item.updatedAt).toLocaleString()} · {item.count} 条</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="settings-panel">
          <div className="settings-head">
            <span>模型设置</span>
            <span className="settings-head-right">
              <span>{currentProvider.label}</span>
              <button className="settings-close" title="关闭设置" onClick={() => setSettingsOpen(false)}>×</button>
            </span>
          </div>
          <div className="settings-body">
            <label className="settings-field">
              <span>Model ID</span>
              <input
                value={settings.model || ''}
                placeholder={currentProvider.value === 'auto' ? 'Hermes backend default' : currentProvider.models[0]?.value || 'model-id'}
                onChange={(e) => updateSettings({ model: e.target.value })}
              />
            </label>
            <div className="settings-note">
              默认推荐把密钥放在 Hermes 后端；这里填写的密钥只保存在 Chrome 本地，并且只发送给 127.0.0.1 后端。
            </div>
            <label className="settings-field">
              <span>API Key</span>
              <input
                type="password"
                value={credentialDraft.apiKey || ''}
                disabled={currentProvider.value === 'auto'}
                placeholder={currentProvider.value === 'auto' ? 'Auto 使用后端配置' : '可选：覆盖后端 API Key'}
                onChange={(e) => setCredentialDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </label>
            <label className="settings-field">
              <span>Base URL</span>
              <input
                value={credentialDraft.baseUrl || ''}
                disabled={currentProvider.value === 'auto'}
                placeholder={currentProvider.value === 'auto' ? 'Auto 使用后端配置' : '可选：自定义 OpenAI-compatible endpoint'}
                onChange={(e) => setCredentialDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
            </label>
            <div className="settings-actions">
              <span className={`settings-state ${providerHasCredential ? 'on' : ''}`}>
                {currentProvider.value === 'auto' ? '后端默认' : providerHasCredential ? '已保存本地覆盖' : '使用后端凭据'}
              </span>
              <button onClick={clearCredentialDraft} disabled={currentProvider.value === 'auto' || !providerHasCredential}>清除</button>
              <button onClick={saveCredentialDraft} disabled={currentProvider.value === 'auto'}>保存</button>
            </div>

            {/* Provider 服务端连接状态 + 操作按钮 */}
            {currentProvider.value !== 'auto' && (
              <div className="provider-status">
                <div className="provider-status-row">
                  <span className={`provider-dot ${providerStatus?.ok ? 'on' : 'off'}`} />
                  <span className="provider-status-msg">
                    {providerBusy ? '查询中…' : (providerStatus?.message || '未查询，点测试连接或登录。')}
                  </span>
                  <button onClick={() => refreshProviderStatus()} disabled={providerBusy}>刷新</button>
                </div>
                <div className="provider-actions">
                  {currentProvider.authType === 'api_key' && (
                    <button onClick={validateProvider} disabled={providerBusy}>测试连接</button>
                  )}
                  {currentProvider.authType === 'oauth' && !oauthSession && (
                    <button onClick={startProviderAuth} disabled={providerBusy}>
                      登录 {currentProvider.label}
                    </button>
                  )}
                  {providerStatus?.ok && currentProvider.authType !== 'backend_config' && (
                    <button onClick={logoutProvider} disabled={providerBusy}>登出</button>
                  )}
                </div>
                {oauthSession && (
                  <div className="oauth-card">
                    <div className="oauth-title">完成登录</div>
                    {oauthSession.userCode && (
                      <div className="oauth-code">
                        <span className="oauth-code-label">设备码</span>
                        <code>{oauthSession.userCode}</code>
                      </div>
                    )}
                    {oauthSession.loginUrl && (
                      <div className="oauth-url">
                        <a href={oauthSession.loginUrl} target="_blank" rel="noreferrer">{oauthSession.loginUrl}</a>
                      </div>
                    )}
                    <div className="oauth-actions">
                      <span className="oauth-hint">在浏览器完成授权后会自动检测。</span>
                      <button onClick={() => { setOauthSession(null); stopOauthPoll(); }}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {providerBanner && (
        <div className="provider-banner" role="alert">
          <span>{providerBanner}</span>
          <button onClick={() => setProviderBanner(null)} aria-label="dismiss">×</button>
        </div>
      )}
      {setupNotice && (
        <div className={`setup-notice ${setupNotice.level}`} role={setupNotice.level === 'error' ? 'alert' : 'status'}>
          <div className="setup-copy">
            <div className="setup-title">{setupNotice.title}</div>
            <div className="setup-body">{setupNotice.body}</div>
            {setupNotice.command && <code>{setupNotice.command}</code>}
          </div>
          <div className="setup-actions">
            {setupNotice.command && (
              <button onClick={() => navigator.clipboard.writeText(setupNotice.command).catch(() => {})}>复制命令</button>
            )}
            <button onClick={() => refreshProviderStatus()} disabled={!connected || providerBusy}>
              重新检测
            </button>
            {connected && setupNotice.level === 'warn' && (
              <button onClick={() => setSettingsOpen(true)}>打开设置</button>
            )}
          </div>
        </div>
      )}
      <div className="feed" ref={feedRef}
        tabIndex={-1}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onKeyDown={(e) => {
          if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) onUserScroll();
        }}
      >
        {entries.length === 0 && (
          <div className="feed-empty">告诉 Hermes 你想做什么<br/>比如「查一下 Sonnet 4 最新论文，列三篇」</div>
        )}
        {(() => {
          type Turn = { user?: Entry; body: Entry[] };
          const turns: Turn[] = [];
          let cur: Turn = { body: [] };
          for (const e of entries) {
            if (e.kind === 'user') {
              if (cur.user || cur.body.length) turns.push(cur);
              cur = { user: e, body: [] };
            } else {
              cur.body.push(e);
            }
          }
          if (cur.user || cur.body.length) turns.push(cur);

          type Group = { kind: 'group'; tools: Entry[] } | { kind: 'item'; entry: Entry };
          const makeGroups = (items: Entry[]): Group[] => {
            const gs: Group[] = [];
            for (const e of items) {
              if (e.kind === 'tool') {
                const last = gs[gs.length - 1];
                if (last && last.kind === 'group') last.tools.push(e);
                else gs.push({ kind: 'group', tools: [e] });
              } else {
                gs.push({ kind: 'item', entry: e });
              }
            }
            return gs;
          };

          const renderGroup = (g: Group, gi: number, prevAiAvatar: { shown: boolean }) => {
            if (g.kind === 'group') {
              const total = g.tools.length;
              const done = g.tools.filter((t) => t.kind === 'tool' && t.status !== 'pending').length;
              const hasError = g.tools.some((t) => t.kind === 'tool' && t.status === 'error');
              const allDone = done === total;
              const chipLabel = allDone
                ? (hasError ? `🔧 ${total} 个工具（含错误）` : `🔧 ${total} 个工具`)
                : `🔧 ${done}/${total} 工具中…`;
              prevAiAvatar.shown = false; // 工具组打断 ai 连续性
              return (
                <details key={`g${gi}`} className="tool-group">
                  <summary className="tool-chip">{chipLabel}</summary>
                  <div className="tool-list">
                    {g.tools.map((t, ti) => t.kind === 'tool' ? <ToolRow key={ti} t={t} index={ti + 1} /> : null)}
                  </div>
                </details>
              );
            }
            const e = g.entry;
            const i = gi;
            if (e.kind === 'thinking') {
              prevAiAvatar.shown = false;
              return (
                <div key={i} className="ai-block no-avatar">
                  <div className="ai-body">
                    <div className="msg thinking">{e.text}</div>
                  </div>
                </div>
              );
            }
            if (e.kind === 'text') {
              const showAvatar = !prevAiAvatar.shown;
              prevAiAvatar.shown = true;
              return (
                <div key={i} className={`msg-wrap ai`}>
                  <div className={`ai-block ${showAvatar ? '' : 'no-avatar'}`}>
                    {showAvatar && <Avatar small />}
                    <div className="ai-body md" dangerouslySetInnerHTML={renderMd(e.text)} />
                  </div>
                  <CopyBtn text={e.text} />
                </div>
              );
            }
            if (e.kind === 'approval') {
              prevAiAvatar.shown = false;
              const cls = `approval-card ${e.status}`;
              const title = e.status === 'pending' ? '🔐 Hermes 想执行' : e.status === 'approved' ? '✅ 已允许' : '🚫 已拒绝';
              return (
                <div key={i} className={cls}>
                  <div className="approval-title">{title}<span className="tool-tag">{e.tool}</span></div>
                  <div className="approval-args">{JSON.stringify(e.args)}</div>
                  {e.status === 'pending' && (
                    <div className="approval-actions">
                      <button className="approval-btn allow" onClick={() => approveCall(e.id, true, e.session_id)}>允许</button>
                      <button className="approval-btn deny" onClick={() => approveCall(e.id, false, e.session_id)}>拒绝</button>
                    </div>
                  )}
                </div>
              );
            }
            return null;
          };

          return turns.map((t, ti) => {
            const isLastTurn = ti === turns.length - 1;
            const turnRunning = isLastTurn && running;

            let bodyGroups: Group[];
            let trailingText: Entry | null = null;
            if (!turnRunning) {
              const bodyCopy = [...t.body];
              for (let i = bodyCopy.length - 1; i >= 0; i--) {
                if (bodyCopy[i].kind === 'text') {
                  trailingText = bodyCopy[i];
                  bodyCopy.splice(i, 1);
                  break;
                }
              }
              bodyGroups = makeGroups(bodyCopy);
            } else {
              bodyGroups = makeGroups(t.body);
            }

            const hasProcess = bodyGroups.length > 0;
            const processSummary = (() => {
              const toolCount = bodyGroups.reduce((s, g) => s + (g.kind === 'group' ? g.tools.length : 0), 0);
              const thinkingCount = bodyGroups.filter((g) => g.kind === 'item' && g.entry.kind === 'thinking').length;
              const textCount = bodyGroups.filter((g) => g.kind === 'item' && g.entry.kind === 'text').length;
              const parts: string[] = [];
              if (thinkingCount) parts.push(`${thinkingCount} 段思考`);
              if (toolCount) parts.push(`${toolCount} 个工具`);
              if (textCount) parts.push(`${textCount} 段中间回复`);
              return `过程（${parts.join(' · ') || '0 步'}）`;
            })();

            const aiTracker = { shown: false };

            return (
              <div key={ti} style={{ display: 'contents' }}>
                {t.user && t.user.kind === 'user' && (
                  <div className="msg-wrap user">
                    <div className="msg user">{t.user.text}</div>
                    <CopyBtn text={t.user.text} />
                  </div>
                )}
                {turnRunning ? (
                  bodyGroups.map((g, gi) => renderGroup(g, gi, aiTracker))
                ) : (
                  <>
                    {hasProcess && (
                      <details className="process-fold">
                        <summary>{processSummary}</summary>
                        <div className="process-fold-inner">
                          {bodyGroups.map((g, gi) => renderGroup(g, gi, aiTracker))}
                        </div>
                      </details>
                    )}
                    {trailingText && (() => {
                      const showAvatar = !aiTracker.shown;
                      aiTracker.shown = true;
                      const text = (trailingText as any).text;
                      return (
                        <div className="msg-wrap ai">
                          <div className={`ai-block ${showAvatar ? '' : 'no-avatar'}`}>
                            {showAvatar && <Avatar small />}
                            <div className="ai-body md" dangerouslySetInnerHTML={renderMd(text)} />
                          </div>
                          <CopyBtn text={text} />
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            );
          });
        })()}
      </div>
      {!following && hasNew && (
        <button className="scroll-fab" onClick={jumpToBottom}>↓ 新消息</button>
      )}
      <div className="composer">
        <div className="composer-modebar">
          <label className={`chip mode`} title={currentMode.label}>
            <span>{currentMode.icon}</span>
            <select
              value={settings.mode || 'auto'}
              onChange={(e) => updateSettings({ mode: e.target.value as ExecMode })}
            >
              {MODE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="chip-caret">▾</span>
          </label>
        </div>
        <div className="input-wrap">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              if (composingRef.current || (e.nativeEvent as any).isComposing) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            rows={1}
          />
          <div className="composer-toolbar">
            <label className="chip provider-chip" title={currentProvider.description}>
              <select
                value={settings.provider || 'auto'}
                onChange={(e) => updateProvider(e.target.value)}
              >
                {PROVIDER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span className="chip-caret">▾</span>
            </label>
            <label className="chip model-chip" title={currentModel.label}>
              <select
                value={modelSelectValue}
                onChange={(e) => {
                  if (e.target.value === '__custom__') return;
                  updateSettings({ model: e.target.value });
                }}
              >
                {currentProvider.models.map(o => (
                  <option key={o.value || 'default'} value={o.value}>{o.label}</option>
                ))}
                {modelSelectValue === '__custom__' && (
                  <option value="__custom__">{settings.model || 'Custom'}</option>
                )}
              </select>
              <span className="chip-caret">▾</span>
            </label>
            <div className="toolbar-spacer" />
            {running
              ? <button className="stop-fab" onClick={stop} title="停止">■</button>
              : <button className="send-fab" onClick={submit} disabled={!draft.trim() || !connected} title="发送 (⌘↩)">
                  {theme === 'synthwave' ? <>SEND <span className="send-arrow">▸</span></> : 'EXEC'}
                </button>
            }
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}

function ToolRow({ t, index }: { t: Entry & { kind: 'tool' }; index?: number }) {
  const [open, setOpen] = useState(false);
  const badgeText = t.status === 'pending' ? 'RUN' : t.status === 'ok' ? 'DONE' : 'ERR';
  const fullArgs = (() => { try { return JSON.stringify(t.args, null, 2); } catch { return ''; } })();
  const resultText = (() => {
    if (t.status === 'error') return t.error || '';
    if (t.status === 'ok') {
      try { const s = JSON.stringify(t.result, null, 2) ?? ''; return s.length > 2000 ? s.slice(0, 2000) + `\n... (${s.length} chars)` : s; } catch { return ''; }
    }
    return '';
  })();
  const hasDetail = !!(resultText || fullArgs);
  const num = typeof index === 'number' ? `[${String(index).padStart(2, '0')}]` : '';
  return (
    <>
      <div className="tool-row" title={fullArgs}>
        {num && <span className="tool-num">{num}</span>}
        <span className="tool-name">{t.tool}</span>
        <span className="tool-args">{shortArgs(t.args)}</span>
        <span className={`tool-badge ${t.status}`}>{badgeText}</span>
        {hasDetail && t.status !== 'pending' && (
          <button className="tool-toggle" onClick={() => setOpen((v) => !v)} title={open ? '收起' : '展开'}>{open ? '▾' : '▸'}</button>
        )}
      </div>
      {open && resultText && (
        <div className={`tool-result ${t.status === 'error' ? 'error' : ''}`}>{resultText}</div>
      )}
    </>
  );
}
