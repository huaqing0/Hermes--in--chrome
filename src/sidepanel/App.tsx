import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import type { ProviderRequest, ProviderStatus, SidepanelMessage, SwToSidepanelMessage, UserSettings } from '../types/messages';
import { HISTORY_STORAGE_KEY, type Entry, type StoredConversation, type StoredConversationMap } from '../types/history';
import { useT } from './i18n';

marked.setOptions({ breaks: true, gfm: true });

const ALLOWED_MD_TAGS = new Set([
  'A', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S',
  'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
]);
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function sanitizeMarkdownHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  function clean(node: Node): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      if (!ALLOWED_MD_TAGS.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'MATH'].includes(el.tagName)) {
          el.remove();
        } else {
          clean(el);
          el.replaceWith(...Array.from(el.childNodes));
        }
        continue;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (el.tagName === 'A' && name === 'href') {
          try {
            const url = new URL(attr.value, window.location.href);
            if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) el.removeAttribute(attr.name);
          } catch {
            el.removeAttribute(attr.name);
          }
          continue;
        }
        if (el.tagName === 'A' && (name === 'title' || name === 'href')) continue;
        if ((el.tagName === 'TH' || el.tagName === 'TD') && (name === 'colspan' || name === 'rowspan')) continue;
        if (name === 'title') continue;
        el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A' && el.getAttribute('href')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noreferrer noopener');
      }
      clean(el);
    }
  }

  clean(root);
  return root.innerHTML;
}

function renderMd(text: string): { __html: string } {
  try {
    return { __html: sanitizeMarkdownHtml(marked.parse(text, { async: false }) as string) };
  } catch {
    return { __html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  }
}

type ExecMode = 'auto' | 'approval' | 'plan';

type VisionCapability = true | false | 'unknown';
type ModelOption = { value: string; label: string; short: string; vision?: VisionCapability };
type ProviderOption = {
  value: string;
  label: string;
  short: string;
  description: string;
  authType: 'api_key' | 'oauth' | 'custom' | 'backend_config';
  requiredFields?: Array<'apiKey' | 'baseUrl' | 'model'>;
  setupHint: string;
  vision?: VisionCapability;
  models: ModelOption[];
};
type ProviderCredential = { apiKey?: string; baseUrl?: string };
type ProviderCredentialStore = Record<string, ProviderCredential>;

function providerStatusKey(provider: string, model?: string, credential?: { apiKey?: string; baseUrl?: string }): string {
  return [
    provider,
    model || '',
    credential?.apiKey?.trim() ? 'key' : '',
    credential?.baseUrl?.trim() || '',
  ].join(':');
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'auto',
    label: 'Auto / Hermes default',
    short: 'AUTO',
    description: 'Use the Hermes backend\'s current model.provider / model.default config.',
    authType: 'backend_config',
    setupHint: 'Auto uses the Hermes backend\'s current default config.',
    vision: 'unknown',
    models: [{ value: '', label: 'Hermes backend default', short: 'Default' }],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    short: 'DS',
    description: 'DeepSeek official API.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a DeepSeek API Key, or set DEEPSEEK_API_KEY in the backend env.',
    vision: false,
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', short: 'Chat' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', short: 'Reasoner' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash (legacy session)', short: 'V4F' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (legacy session)', short: 'V4P' },
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude',
    short: 'CLAUDE',
    description: 'Anthropic Messages API.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste an Anthropic API Key. If you do not have one, use OpenAI Codex OAuth or Custom (e.g. OpenRouter Base URL).',
    vision: true,
    models: [
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', short: 'Opus 4.8' },
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
    description: 'Google AI Studio API key provider.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a Google AI Studio API Key, or set GOOGLE_API_KEY / GEMINI_API_KEY in the backend env.',
    vision: true,
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
    description: 'xAI official API.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste an xAI API Key, or set XAI_API_KEY in the backend env.',
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
    description: 'Alibaba DashScope OpenAI-compatible API.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a DashScope API Key, or set DASHSCOPE_API_KEY in the backend env.',
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
    description: 'Qwen CLI / Portal OAuth provider.',
    authType: 'oauth',
    setupHint: 'Uses Qwen OAuth. Usually requires running `qwen auth qwen-oauth` on this machine first.',
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
    description: 'Kimi / Moonshot coding provider.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a Kimi / Moonshot API Key, or set KIMI_API_KEY in the backend env.',
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
    description: 'Z.ai / Zhipu GLM provider.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a Z.ai / GLM API Key, or set GLM_API_KEY / ZAI_API_KEY in the backend env.',
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
    description: 'MiniMax Anthropic-compatible provider.',
    authType: 'api_key',
    requiredFields: ['apiKey'],
    setupHint: 'Paste a MiniMax API Key, or use MiniMax OAuth to log in.',
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
    description: 'OpenAI-compatible custom endpoint — local Ollama / vLLM / LM Studio, etc.',
    authType: 'custom',
    requiredFields: ['baseUrl', 'model'],
    setupHint: 'Fill in an OpenAI-compatible Base URL and Model ID; API Key is optional.',
    vision: 'unknown',
    models: [{ value: '', label: 'Custom model ID', short: 'Custom' }],
  },
  {
    value: 'openai-codex',
    label: 'OpenAI Codex OAuth',
    short: 'CODEX',
    description: 'OpenAI Codex device-code OAuth provider. Coding-oriented models can be slower on long browser-operation sessions; start a new chat after switching models.',
    authType: 'oauth',
    setupHint: 'Log in via OpenAI Codex OAuth — no API Key needed. For browser automation, prefer a fresh chat after switching into this provider.',
    vision: true,
    models: [
      { value: 'gpt-5.5', label: 'GPT-5.5', short: '5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4', short: '5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', short: '5.4M' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', short: '5.3C' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', short: '5.3S' },
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
    description: 'Google Gemini CLI / Cloud Code OAuth provider.',
    authType: 'oauth',
    setupHint: 'Uses Google Gemini OAuth — usually requires completing the Gemini CLI login on this machine first.',
    vision: true,
    models: [
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', short: '3F' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', short: '3P' },
    ],
  },
  {
    value: 'minimax-oauth',
    label: 'MiniMax OAuth',
    short: 'MM OAuth',
    description: 'MiniMax OAuth login provider.',
    authType: 'oauth',
    setupHint: 'Log in via MiniMax OAuth — no API Key needed.',
    models: [
      { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', short: 'M2.7' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', short: 'Fast' },
    ],
  },
  {
    value: 'nous',
    label: 'Nous Portal OAuth',
    short: 'NOUS',
    description: 'Nous Portal device-code OAuth provider.',
    authType: 'oauth',
    setupHint: 'Log in via Nous Portal — no API Key needed.',
    models: [
      { value: '', label: 'Nous default model', short: 'Default' },
    ],
  },
];
type ModeKey = 'mode_auto' | 'mode_approval' | 'mode_plan';
type ModeShortKey = 'mode_auto_short' | 'mode_approval_short' | 'mode_plan_short';
const MODE_OPTIONS: { value: ExecMode; labelKey: ModeKey; shortKey: ModeShortKey; icon: string }[] = [
  { value: 'auto', labelKey: 'mode_auto', shortKey: 'mode_auto_short', icon: '🤖' },
  { value: 'approval', labelKey: 'mode_approval', shortKey: 'mode_approval_short', icon: '🔐' },
  { value: 'plan', labelKey: 'mode_plan', shortKey: 'mode_plan_short', icon: '📋' },
];
// placeholder text is built per render from i18n inside App, no module-level dict needed
const DEFAULT_SETTINGS: UserSettings = { provider: 'auto', model: '', vision: 'unknown', mode: 'auto' };
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

function normalizeVisionCapability(value: unknown): VisionCapability | undefined {
  if (value === true || value === false || value === 'unknown') return value;
  return undefined;
}

function defaultVisionForProvider(providerValue?: string, modelValue?: string): VisionCapability {
  const provider = providerByValue(providerValue);
  const model = provider.models.find((m) => m.value === (modelValue || ''));
  return model?.vision ?? provider.vision ?? 'unknown';
}

function normalizeSettings(raw?: UserSettings): UserSettings {
  const provider = raw?.provider || inferProviderFromModel(raw?.model);
  const model = raw?.model ?? defaultModelForProvider(provider);
  const requestedMode: ExecMode = raw?.mode || (raw?.require_approval ? 'approval' : 'auto');
  const mode: ExecMode =
    requestedMode === 'plan' ? 'plan' :
    requestedMode === 'approval' ? 'approval' :
    'auto';
  const vision = normalizeVisionCapability(raw?.vision) ?? defaultVisionForProvider(provider, model);
  return {
    provider,
    model: provider === 'auto' ? (model || '') : model,
    vision,
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

const MAX_STORED_CONVERSATIONS = 100;

function pruneConversations(conversations: StoredConversationMap): StoredConversationMap {
  const entries = Object.entries(conversations)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
  return Object.fromEntries(entries);
}

async function writeConversations(conversations: StoredConversationMap): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: pruneConversations(conversations) });
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

const MAX_HISTORY_STRING_CHARS = 4_000;
const MAX_HISTORY_RESULT_JSON_CHARS = 50_000;
const MAX_HISTORY_RESULT_PREVIEW_CHARS = 12_000;

function compactForHistory(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_HISTORY_STRING_CHARS
      ? `${value.slice(0, MAX_HISTORY_STRING_CHARS)}\n... [truncated ${value.length - MAX_HISTORY_STRING_CHARS} chars]`
      : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth > 4) return '[object truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => compactForHistory(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'data' || key === 'content') && typeof item === 'string' && item.length > 20_000) {
      out[key] = `[omitted ${item.length} chars]`;
      out[`${key}_omitted_chars`] = item.length;
    } else {
      out[key] = compactForHistory(item, depth + 1);
    }
  }
  return out;
}

function compactToolResultForHistory(tool: string, data: unknown): unknown {
  const compacted = compactForHistory(data);
  try {
    const json = JSON.stringify(compacted);
    if (json.length <= MAX_HISTORY_RESULT_JSON_CHARS) return compacted;
    return {
      truncated: true,
      tool,
      original_json_chars: json.length,
      preview: json.slice(0, MAX_HISTORY_RESULT_PREVIEW_CHARS),
    };
  } catch {
    return compacted;
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
  const { t } = useT();
  return (
    <button
      className={`copy-btn ${copied ? 'copied' : ''}`}
      title={copied ? t('copy_done') : t('copy_do')}
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
const ONBOARDING_CACHE_KEY = 'hermes_onboarding_v1';

type CheckState = 'checking' | 'ok' | 'fail';

function localProviderConfigReady(provider: ProviderOption, settings: UserSettings, credential?: ProviderCredential): boolean {
  if (provider.authType === 'custom') {
    return !!credential?.baseUrl?.trim() && !!settings.model?.trim();
  }
  if (provider.authType === 'api_key') {
    return !!credential?.apiKey?.trim() || !!credential?.baseUrl?.trim();
  }
  return false;
}

function onboardingProviderState(args: {
  backend: CheckState;
  connected: boolean;
  provider: ProviderOption;
  providerStatus: ProviderStatus | null;
  hasLocalConfig: boolean;
  checking: boolean;
}): CheckState {
  const { backend, connected, provider, providerStatus, hasLocalConfig, checking } = args;
  if (provider.value === 'auto') {
    if (connected) return 'ok';
    return backend === 'checking' ? 'checking' : 'fail';
  }

  if (checking) return 'checking';
  if (providerStatus) return providerStatus.ok ? 'ok' : 'fail';
  if (provider.authType === 'custom' && hasLocalConfig) return connected ? 'checking' : 'ok';
  if (hasLocalConfig) return connected ? 'checking' : 'fail';
  return backend === 'checking' ? 'checking' : 'fail';
}

interface OnboardingBarProps {
  backend: CheckState;
  nativeHost: CheckState;
  provider: CheckState;
  extensionId: string;
  repoRoot: string | null;
  hostError?: string;
  expanded: boolean;
  onToggle: () => void;
  onRecheck: () => void;
  onOpenSettings: () => void;
}

function buildOneliner(repoRoot: string | null, cmd: string, placeholder: string): { line: string; needsManualCd: boolean } {
  if (repoRoot) {
    const quoted = `'${repoRoot.replace(/'/g, `'\\''`)}'`;
    return { line: `cd ${quoted} && ${cmd}`, needsManualCd: false };
  }
  return { line: `cd ${placeholder} && ${cmd}`, needsManualCd: true };
}

function OnboardingStatusBar(p: OnboardingBarProps) {
  const { backend, nativeHost, provider, extensionId, repoRoot, hostError, expanded, onToggle, onRecheck, onOpenSettings } = p;
  const { t } = useT();
  const placeholder = t('ob_repo_placeholder');
  const backendLine = buildOneliner(repoRoot, 'npm run backend:ensure', placeholder);
  const installRaw = extensionId
    ? `npm run native-host:install -- ${extensionId}`
    : 'npm run native-host:install -- <extension-id>';
  const installLine = buildOneliner(repoRoot, installRaw, placeholder);
  return (
    <div className={`onboarding-bar ${expanded ? 'expanded' : 'collapsed'}`}>
      <button type="button" className="ob-summary" onClick={onToggle} title={expanded ? t('ob_toggle_collapse') : t('ob_toggle_expand')}>
        <span className={`ob-dot ob-${backend}`} /><span className="ob-name">{t('ob_summary_backend')}</span>
        <span className={`ob-dot ob-${nativeHost}`} /><span className="ob-name">{t('ob_summary_host')}</span>
        <span className={`ob-dot ob-${provider}`} /><span className="ob-name">{t('ob_summary_provider')}</span>
        <span className="ob-spacer" />
        <span className="ob-toggle">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="ob-cards">
          {backend !== 'ok' && (
            <div className="ob-card">
              <div className="ob-card-title">{backend === 'checking' ? t('ob_backend_title_checking') : t('ob_backend_title_fail')}</div>
              <div className="ob-card-body">
                <div>{t('ob_paste_to_terminal')}</div>
                <div className="ob-cmd-row"><code>{backendLine.line}</code><CopyBtn text={backendLine.line} /></div>
                {backendLine.needsManualCd && (
                  <div className="ob-hint">{t('ob_replace_placeholder_backend')}</div>
                )}
                <div className="ob-hint">{t('ob_hint_install_agent')}</div>
              </div>
              <button className="ob-recheck" onClick={onRecheck} disabled={backend === 'checking'}>{t('ob_recheck')}</button>
            </div>
          )}
          {nativeHost !== 'ok' && (
            <div className="ob-card">
              <div className="ob-card-title">{nativeHost === 'checking' ? t('ob_host_title_checking') : t('ob_host_title_fail')}</div>
              <div className="ob-card-body">
                <div>{t('ob_host_body')}</div>
                <div className="ob-id-row">
                  <span className="ob-id-label">{t('ob_host_ext_id')}</span>
                  <code className="ob-id">{extensionId || t('ob_host_ext_id_loading')}</code>
                  {extensionId && <CopyBtn text={extensionId} />}
                </div>
                <div>{t('ob_paste_to_terminal')}</div>
                <div className="ob-cmd-row"><code>{installLine.line}</code>{extensionId && <CopyBtn text={installLine.line} />}</div>
                {installLine.needsManualCd && (
                  <div className="ob-hint">{t('ob_replace_placeholder_install')}</div>
                )}
                <div className="ob-hint">{t('ob_host_after_install')}</div>
                {hostError && <div className="ob-error">{t('ob_host_error_prefix')}{hostError}</div>}
              </div>
              <button className="ob-recheck" onClick={onRecheck} disabled={nativeHost === 'checking'}>{t('ob_recheck')}</button>
            </div>
          )}
          {provider !== 'ok' && (
            <div className="ob-card">
              <div className="ob-card-title">{provider === 'checking' ? t('ob_provider_title_checking') : t('ob_provider_title_fail')}</div>
              <div className="ob-card-body">
                <div>{provider === 'checking' ? t('ob_provider_body_checking') : t('ob_provider_body_fail')}</div>
              </div>
              <button className="ob-recheck" onClick={onOpenSettings}>{t('ob_open_settings')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { t, lang, toggleLang } = useT();
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
  const [providerStatusCheckedKey, setProviderStatusCheckedKey] = useState('');
  const [oauthSession, setOauthSession] = useState<{ provider: string; loginUrl?: string; userCode?: string; sessionId?: string; pollInterval?: number } | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [startupChecking, setStartupChecking] = useState(false);
  const [providerBanner, setProviderBanner] = useState<string | null>(null);
  const oauthPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupCheckKeyRef = useRef('');
  const [credentials, setCredentials] = useState<ProviderCredentialStore>({});
  const credentialsRef = useRef<ProviderCredentialStore>({});
  const [credentialDraft, setCredentialDraft] = useState<ProviderCredential>({});
  const [obBackend, setObBackend] = useState<CheckState>('checking');
  const [obNativeHost, setObNativeHost] = useState<CheckState>('checking');
  const [obExtId, setObExtId] = useState('');
  const [obRepoRoot, setObRepoRoot] = useState<string | null>(null);
  const [obHostError, setObHostError] = useState<string | undefined>(undefined);
  const [obExpanded, setObExpanded] = useState(true);
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
    const model = defaultModelForProvider(provider);
    updateSettings({ provider, model, vision: defaultVisionForProvider(provider, model) });
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
      vision: settings.vision,
      ...(apiKey || baseUrl
        ? { credentialOverride: { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) } }
        : {}),
      ...(extra || {}),
    };
  }

  function checkedKeyForRequest(request: ProviderRequest): string {
    return providerStatusKey(request.provider, request.model, request.credentialOverride);
  }

  function currentSavedProviderStatusKey(): string {
    const provider = settings.provider || 'auto';
    return providerStatusKey(provider, settings.model, credentials[provider]);
  }

  async function refreshProviderStatus(options: { silent?: boolean } = {}) {
    const request = buildProviderRequest();
    const checkedKey = checkedKeyForRequest(request);
    if (options.silent) setStartupChecking(true);
    else setProviderBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_STATUS',
        request,
      } satisfies SidepanelMessage);
      if (resp?.status) {
        setProviderStatus(resp.status);
        setProviderStatusCheckedKey(checkedKey);
      }
    } catch (e) {
      setProviderStatus({
        provider: settings.provider || 'auto',
        ok: false, connected: false,
        message: `${t('banner_status_query_failed')}: ${e instanceof Error ? e.message : String(e)}`,
      });
      setProviderStatusCheckedKey(checkedKey);
    } finally {
      if (options.silent) setStartupChecking(false);
      else setProviderBusy(false);
    }
  }

  async function validateProvider() {
    const request = buildProviderRequest({ check: 'text' });
    const checkedKey = checkedKeyForRequest(request);
    setProviderBusy(true);
    setProviderBanner(null);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_VALIDATE',
        request,
      } satisfies SidepanelMessage);
      if (resp?.status) {
        setProviderStatus(resp.status);
        setProviderStatusCheckedKey(checkedKey);
      }
    } catch (e) {
      setProviderBanner(`${t('banner_validate_failed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProviderBusy(false);
    }
  }

  async function validateVision() {
    const request = buildProviderRequest({ check: 'vision' });
    const checkedKey = checkedKeyForRequest(request);
    setProviderBusy(true);
    setProviderBanner(null);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_VALIDATE',
        request,
      } satisfies SidepanelMessage);
      if (resp?.status) {
        setProviderStatus(resp.status);
        setProviderStatusCheckedKey(checkedKey);
      }
    } catch (e) {
      setProviderBanner(`${t('banner_validate_failed')}: ${e instanceof Error ? e.message : String(e)}`);
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
          setProviderStatusCheckedKey(currentSavedProviderStatusKey());
          setOauthSession(null);
          setProviderBanner(t('banner_login_success'));
          stopOauthPoll();
          return;
        }
        if (status.message && /expired|denied|error/i.test(status.message)) {
          setProviderBanner(`${t('banner_login_incomplete')}: ${status.message}`);
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
    const request = buildProviderRequest();
    const checkedKey = checkedKeyForRequest(request);
    setProviderBusy(true);
    setProviderBanner(null);
    try {
      const provider = settings.provider || 'auto';
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_AUTH_START',
        request,
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
        setProviderStatusCheckedKey(checkedKey);
        if (status.loginUrl) {
          try { window.open(status.loginUrl, '_blank', 'noopener'); } catch {}
        }
        schedulePoll(provider, status.sessionId, status.pollInterval || 5);
      } else {
        setProviderBanner(status?.message || t('banner_login_failed_hint'));
      }
    } catch (e) {
      setProviderBanner(`${t('banner_login_failed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProviderBusy(false);
    }
  }

  async function logoutProvider() {
    const checkedKey = currentSavedProviderStatusKey();
    setProviderBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SP_PROVIDER_LOGOUT',
        request: buildProviderRequest(),
      } satisfies SidepanelMessage);
      if (resp?.status) {
        setProviderStatus(resp.status);
        setProviderStatusCheckedKey(checkedKey);
      }
      setOauthSession(null);
      stopOauthPoll();
    } catch (e) {
      setProviderBanner(`${t('banner_logout_failed')}: ${e instanceof Error ? e.message : String(e)}`);
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
    const key = providerStatusKey(provider, settings.model, credential);
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

  // 缓存恢复：首次渲染不闪烁
  useEffect(() => {
    chrome.storage.local.get(ONBOARDING_CACHE_KEY).then((r) => {
      const cached = r[ONBOARDING_CACHE_KEY] as { backend?: CheckState; nativeHost?: CheckState; extId?: string; repoRoot?: string | null; expanded?: boolean } | undefined;
      if (cached) {
        if (cached.backend) setObBackend(cached.backend);
        if (cached.nativeHost) setObNativeHost(cached.nativeHost);
        if (cached.extId) setObExtId(cached.extId);
        if (cached.repoRoot !== undefined) setObRepoRoot(cached.repoRoot);
        if (typeof cached.expanded === 'boolean') setObExpanded(cached.expanded);
      }
    }).catch(() => {});
  }, []);

  function recheckOnboarding() {
    setObBackend('checking');
    setObNativeHost('checking');
    chrome.runtime.sendMessage({ type: 'SP_ONBOARDING_CHECK_BACKEND' } satisfies SidepanelMessage)
      .then((r: { status?: 'healthy' | 'offline' } | undefined) => {
        const healthy = r?.status === 'healthy';
        setObBackend(healthy ? 'ok' : 'fail');
        if (healthy) refreshProviderStatus({ silent: true }).catch(() => {});
      })
      .catch(() => setObBackend('fail'));
    chrome.runtime.sendMessage({ type: 'SP_ONBOARDING_CHECK_NATIVE_HOST' } satisfies SidepanelMessage)
      .then((r: { installed?: boolean; error?: string; repoRoot?: string | null } | undefined) => {
        if (r?.installed) {
          setObNativeHost('ok');
          setObHostError(undefined);
          if (r.repoRoot !== undefined) setObRepoRoot(r.repoRoot);
        } else {
          setObNativeHost('fail');
          setObHostError(r?.error);
        }
      })
      .catch((e: unknown) => {
        setObNativeHost('fail');
        setObHostError(e instanceof Error ? e.message : String(e));
      });
    if (!obExtId) {
      chrome.runtime.sendMessage({ type: 'SP_ONBOARDING_GET_EXTENSION_ID' } satisfies SidepanelMessage)
        .then((r: { id?: string } | undefined) => {
          if (r?.id) setObExtId(r.id);
        })
        .catch(() => {});
    }
  }

  // 挂载时跑一次
  useEffect(() => {
    recheckOnboarding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Provider 状态来自实际后端检查；本地凭据只作为“可检查”的信号，避免 OAuth/Custom 被误判。
  const onboardingProvider = providerByValue(settings.provider || 'auto');
  const onboardingProviderKey = providerStatusKey(onboardingProvider.value, settings.model, credentials[onboardingProvider.value]);
  const onboardingProviderStatus =
    providerStatus?.provider === onboardingProvider.value && providerStatusCheckedKey === onboardingProviderKey ? providerStatus : null;
  const onboardingLocalConfigReady = localProviderConfigReady(onboardingProvider, settings, credentials[onboardingProvider.value]);
  const obProvider: CheckState = (() => {
    return onboardingProviderState({
      backend: obBackend,
      connected,
      provider: onboardingProvider,
      providerStatus: onboardingProviderStatus,
      hasLocalConfig: onboardingLocalConfigReady,
      checking: startupChecking || providerBusy,
    });
  })();

  // 全绿自动折叠；任一 fail 自动展开；持久化状态
  useEffect(() => {
    const allGreen = obBackend === 'ok' && obNativeHost === 'ok' && obProvider === 'ok';
    const anyFail = obBackend === 'fail' || obNativeHost === 'fail' || obProvider === 'fail';
    if (allGreen && obExpanded) setObExpanded(false);
    else if (anyFail && !obExpanded) setObExpanded(true);
    chrome.storage.local.set({
      [ONBOARDING_CACHE_KEY]: { backend: obBackend, nativeHost: obNativeHost, extId: obExtId, repoRoot: obRepoRoot, expanded: obExpanded },
    }).catch(() => {});
  }, [obBackend, obNativeHost, obProvider, obExpanded, obExtId, obRepoRoot]);

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
            next[i] = {
              ...e,
              status: msg.ok ? 'ok' : 'error',
              result: msg.ok ? compactToolResultForHistory(e.tool, msg.data) : msg.data,
              error: msg.error,
            };
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
      const submitStatusKey = providerStatusKey(provider, settings.model, cred);
      const knownConnected =
        providerStatus && providerStatus.provider === provider && providerStatus.ok && providerStatusCheckedKey === submitStatusKey;
      if (!hasLocalKey && !knownConnected) {
        // 主动查一次，避免冷启动空值
        try {
          const request = { provider, model: settings.model };
          const resp = await chrome.runtime.sendMessage({
            type: 'SP_PROVIDER_STATUS',
            request,
          } satisfies SidepanelMessage);
          const s = resp?.status as ProviderStatus | undefined;
          if (s) {
            setProviderStatus(s);
            setProviderStatusCheckedKey(providerStatusKey(request.provider, request.model));
          }
          if (!s?.ok) {
            const baseHint = s?.message || s?.hint || t('banner_provider_not_set', { provider: providerByValue(provider).label });
            setProviderBanner(baseHint);
            setSettingsOpen(true);
            return;
          }
        } catch (e) {
          setProviderBanner(`${t('banner_provider_status_failed')}: ${e instanceof Error ? e.message : String(e)}`);
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
          const next = [...prev, { kind: 'text' as const, text: `❌ ${resp.error || t('banner_send_failed')}` }];
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
      setEntries((prev) => [...prev, { kind: 'text', text: `❌ ${t('banner_send_failed')}: ${e instanceof Error ? e.message : String(e)}` }]);
      setRunning(false);
    }
  }

  async function stop() {
    await chrome.runtime.sendMessage({ type: 'SP_STOP' } satisfies SidepanelMessage);
    if (currentSessionId) runningBySession[currentSessionId] = false;
    setRunning(false);
  }

  async function newChat() {
    if (running && !confirm(t('banner_running_switch_confirm'))) return;
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

  const placeholder = `${t('input_placeholder')}  (⌘↩)`;
  const currentMode = MODE_OPTIONS.find(o => o.value === (settings.mode || 'auto')) || MODE_OPTIONS[0];
  const currentProvider = providerByValue(settings.provider || 'auto');
  const currentModel = currentProvider.models.find(o => o.value === (settings.model || '')) || {
    value: settings.model || '',
    label: settings.model || currentProvider.models[0]?.label || 'Hermes backend default',
    short: shortModelLabel(settings.model || ''),
    vision: settings.vision ?? currentProvider.vision ?? 'unknown',
  };
  const currentVision = settings.vision ?? currentModel.vision ?? currentProvider.vision ?? 'unknown';
  const visionLabel =
    currentVision === true ? t('settings_vision_true')
      : currentVision === false ? t('settings_vision_false')
        : t('settings_vision_unknown');
  const modelSelectValue = currentProvider.models.some((m) => m.value === (settings.model || ''))
    ? (settings.model || '')
    : '__custom__';
  const providerHasCredential = !!credentials[currentProvider.value]?.apiKey || !!credentials[currentProvider.value]?.baseUrl;
  const currentStatusCredential = settingsOpen
    ? {
        apiKey: credentialDraft.apiKey?.trim() || credentials[currentProvider.value]?.apiKey,
        baseUrl: credentialDraft.baseUrl?.trim() || credentials[currentProvider.value]?.baseUrl,
      }
    : credentials[currentProvider.value];
  const currentProviderStatusKey = providerStatusKey(currentProvider.value, settings.model, currentStatusCredential);
  const statusForCurrentProvider =
    providerStatus?.provider === currentProvider.value && providerStatusCheckedKey === currentProviderStatusKey ? providerStatus : null;
  const setupNotice = !connected
    ? {
        level: 'error' as const,
        title: t('banner_backend_offline'),
        body: t('banner_backend_offline_hint'),
        command: 'npm run backend:ensure',
      }
    : startupChecking
      ? {
          level: 'checking' as const,
          title: t('banner_provider_checking'),
          body: t('banner_provider_checking_hint', { provider: currentProvider.label }),
          command: '',
        }
      : statusForCurrentProvider && !statusForCurrentProvider.ok
        ? {
            level: 'warn' as const,
            title: `${currentProvider.label} — ${t('banner_provider_not_ready')}`,
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
          <OnboardingStatusBar
            backend={obBackend}
            nativeHost={obNativeHost}
            provider={obProvider}
            extensionId={obExtId}
            repoRoot={obRepoRoot}
            hostError={obHostError}
            expanded={obExpanded}
            onToggle={() => setObExpanded((v) => !v)}
            onRecheck={recheckOnboarding}
            onOpenSettings={() => { setSettingsOpen(true); setObExpanded(false); }}
          />
          <div className="header">
            <div className="logo">
              <div title={currentSessionId || ''}><Avatar /></div>
              <div className="logo-text">
                <div className="logo-name">HERMES</div>
                <div className="logo-sub">
                  花清 Hua Qing
                </div>
                <div className="logo-meta">
                  <span className="ver">v0.3</span>
                  <span className="sep">·</span>
                  <span className="model">{currentProvider.short}</span>
                  <span className="sep">/</span>
                  <span className="model">{currentModel.short}</span>
                  <span className="sep">·</span>
                  <span className={`status ${connected ? '' : 'offline'}`}><span className="dot" />{connected ? t('status_online') : t('status_offline')}</span>
                </div>
              </div>
            </div>
            <div className="header-actions">
              <div className="action-help" aria-hidden="true">
                <span>⚙ {t('header_settings_short')}</span>
                <span>◐ {t('header_theme_short')}</span>
                <span>EN {t('header_lang_short')}</span>
                <span>◷ {t('header_history_short')}</span>
                <span>⤓ {t('header_export_short')}</span>
                <span>+ {t('header_new_chat_short')}</span>
              </div>
              <button className={`icon-btn ${settingsOpen ? 'active' : ''}`} title={t('header_settings')} aria-label={t('header_settings')} onClick={() => setSettingsOpen((v) => !v)}>⚙</button>
              <button
                className="icon-btn theme-toggle"
                title={theme === 'dystopia' ? t('header_theme_to_synthwave') : t('header_theme_to_dystopia')}
                aria-label={theme === 'dystopia' ? t('header_theme_to_synthwave') : t('header_theme_to_dystopia')}
                onClick={toggleTheme}
              >{theme === 'dystopia' ? '◐' : '◑'}</button>
              <button
                className="icon-btn lang-toggle"
                title={t('header_lang_toggle')}
                aria-label={t('header_lang_toggle')}
                onClick={toggleLang}
              >{lang === 'zh' ? 'EN' : '中'}</button>
              <button className={`icon-btn ${historyOpen ? 'active' : ''}`} title={t('header_history')} aria-label={t('header_history')} onClick={() => { setHistoryOpen((v) => !v); refreshHistory().catch(() => {}); }}>◷</button>
              <button className="icon-btn" title={t('header_export_md')} aria-label={t('header_export_md')} onClick={exportConversation} disabled={entries.length === 0}>⤓</button>
              <button className="icon-btn" title={t('header_new_chat')} aria-label={t('header_new_chat')} onClick={newChat}>+</button>
            </div>
          </div>
          <div className="system-bar" aria-hidden="true">
            <div className="hazard-mini" />
            <span>{t('system_op', { n: toolCount })}</span>
          </div>
          <div className="tab-meta" title={currentTabTitle || ''}>
            <span className="tab-fav" />
            <span className="tab-url">{currentTabTitle || '—'}</span>
            <span className="tab-id">{t('tab_tag')}</span>
          </div>
      {historyOpen && (
        <div className="history-panel">
          <div className="history-head">
            <span>{t('history_title')}</span>
            <span>{historyItems.length}</span>
          </div>
          <div className="history-list">
            {historyItems.length === 0 && <div className="history-empty">{t('history_empty')}</div>}
            {historyItems.map((item) => (
              <button
                key={item.id}
                className={`history-item ${item.id === currentSessionId ? 'current' : ''}`}
                onClick={() => selectHistory(item.id)}
                title={item.title}
              >
                <span className="history-title">{item.title}</span>
                <span className="history-meta">{new Date(item.updatedAt).toLocaleString()} · {item.count}{t('history_count_suffix') ? ' ' + t('history_count_suffix') : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="settings-panel">
          <div className="settings-head">
            <span>{t('settings_title')}</span>
            <span className="settings-head-right">
              <span>{currentProvider.label}</span>
              <button className="settings-close" title={t('settings_close')} onClick={() => setSettingsOpen(false)}>×</button>
            </span>
          </div>
          <div className="settings-body">
            <label className="settings-field">
              <span>{t('settings_model_id')}</span>
              <input
                value={settings.model || ''}
                placeholder={currentProvider.value === 'auto' ? t('settings_model_id_placeholder_auto') : currentProvider.models[0]?.value || 'model-id'}
                onChange={(e) => updateSettings({
                  model: e.target.value,
                  vision: currentProvider.value === 'custom'
                    ? (settings.vision ?? 'unknown')
                    : defaultVisionForProvider(currentProvider.value, e.target.value),
                })}
              />
            </label>
            <div className="settings-note">
              {t('settings_local_note')}
            </div>
            <div className="settings-note">
              {t('settings_vision_status')}: <strong>{visionLabel}</strong>. {t('settings_vision_note')}
            </div>
            {currentProvider.value === 'custom' && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.vision === true}
                  onChange={(e) => updateSettings({ vision: e.target.checked ? true : 'unknown' })}
                />
                <span>{t('settings_custom_vision')}</span>
              </label>
            )}
            <label className="settings-field">
              <span>{t('settings_api_key')}</span>
              <input
                type="password"
                value={credentialDraft.apiKey || ''}
                disabled={currentProvider.value === 'auto'}
                placeholder={currentProvider.value === 'auto' ? t('settings_apikey_placeholder_auto') : t('settings_apikey_placeholder_default')}
                onChange={(e) => setCredentialDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </label>
            <label className="settings-field">
              <span>{t('settings_base_url')}</span>
              <input
                value={credentialDraft.baseUrl || ''}
                disabled={currentProvider.value === 'auto'}
                placeholder={currentProvider.value === 'auto' ? t('settings_baseurl_placeholder_auto') : t('settings_baseurl_placeholder_default')}
                onChange={(e) => setCredentialDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
            </label>
            <div className="settings-actions">
              <span className={`settings-state ${providerHasCredential ? 'on' : ''}`}>
                {currentProvider.value === 'auto' ? t('settings_status_auto') : providerHasCredential ? t('settings_status_local_override') : t('settings_status_backend_cred')}
              </span>
              <button onClick={clearCredentialDraft} disabled={currentProvider.value === 'auto' || !providerHasCredential}>{t('settings_clear')}</button>
              <button onClick={saveCredentialDraft} disabled={currentProvider.value === 'auto'}>{t('settings_save')}</button>
            </div>

            {/* Provider service status + actions */}
            {currentProvider.value !== 'auto' && (
              <div className="provider-status">
                <div className="provider-status-row">
                  <span className={`provider-dot ${statusForCurrentProvider?.ok ? 'on' : 'off'}`} />
                  <span className="provider-status-msg">
                    {providerBusy ? t('settings_querying') : (statusForCurrentProvider?.message || t('settings_no_status'))}
                  </span>
                  <button onClick={() => refreshProviderStatus()} disabled={providerBusy}>{t('settings_refresh')}</button>
                </div>
                <div className="provider-actions">
                  {currentProvider.authType !== 'backend_config' && (
                    <button onClick={validateProvider} disabled={providerBusy}>{t('settings_test_model')}</button>
                  )}
                  {currentProvider.authType !== 'backend_config' && (
                    <button onClick={validateVision} disabled={providerBusy}>{t('settings_test_vision')}</button>
                  )}
                  {currentProvider.authType === 'oauth' && !oauthSession && (
                    <button onClick={startProviderAuth} disabled={providerBusy}>
                      {t('settings_login_with', { provider: currentProvider.label })}
                    </button>
                  )}
                  {statusForCurrentProvider?.ok && currentProvider.authType !== 'backend_config' && (
                    <button onClick={logoutProvider} disabled={providerBusy}>{t('settings_logout')}</button>
                  )}
                </div>
                {oauthSession && (
                  <div className="oauth-card">
                    <div className="oauth-title">{t('settings_finish_login')}</div>
                    {oauthSession.userCode && (
                      <div className="oauth-code">
                        <span className="oauth-code-label">{t('settings_device_code')}</span>
                        <code>{oauthSession.userCode}</code>
                      </div>
                    )}
                    {oauthSession.loginUrl && (
                      <div className="oauth-url">
                        <a href={oauthSession.loginUrl} target="_blank" rel="noreferrer">{oauthSession.loginUrl}</a>
                      </div>
                    )}
                    <div className="oauth-actions">
                      <span className="oauth-hint">{t('settings_oauth_hint')}</span>
                      <button onClick={() => { setOauthSession(null); stopOauthPoll(); }}>{t('settings_cancel')}</button>
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
              <button onClick={() => navigator.clipboard.writeText(setupNotice.command).catch(() => {})}>{t('banner_copy_cmd')}</button>
            )}
            <button onClick={() => refreshProviderStatus()} disabled={!connected || providerBusy}>
              {t('banner_recheck')}
            </button>
            {connected && setupNotice.level === 'warn' && (
              <button onClick={() => setSettingsOpen(true)}>{t('banner_open_settings')}</button>
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
          <div className="feed-empty">{t('input_placeholder')}</div>
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
                ? (hasError ? `🔧 ${t('feed_tool_count_with_err', { n: total })}` : `🔧 ${t('feed_tool_count', { n: total })}`)
                : `🔧 ${done}/${total} ${t('feed_tool_running')}…`;
              prevAiAvatar.shown = false; // 工具组打断 ai 连续性
              return (
                <details key={`g${gi}`} className="tool-group">
                  <summary className="tool-chip">{chipLabel}</summary>
                  <div className="tool-list">
                    {g.tools.map((tool, ti) => tool.kind === 'tool' ? <ToolRow key={ti} t={tool} index={ti + 1} /> : null)}
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
              const title = e.status === 'pending'
                ? `🔐 Hermes ${t('approval_want_run')}`
                : e.status === 'approved'
                  ? `✅ ${t('approval_allowed')}`
                  : `🚫 ${t('approval_denied')}`;
              return (
                <div key={i} className={cls}>
                  <div className="approval-title">{title}<span className="tool-tag">{e.tool}</span></div>
                  <div className="approval-args">{JSON.stringify(e.args)}</div>
                  {e.status === 'pending' && (
                    <div className="approval-actions">
                      <button className="approval-btn allow" onClick={() => approveCall(e.id, true, e.session_id)}>{t('approval_allow')}</button>
                      <button className="approval-btn deny" onClick={() => approveCall(e.id, false, e.session_id)}>{t('approval_deny')}</button>
                    </div>
                  )}
                </div>
              );
            }
            return null;
          };

          return turns.map((turn, ti) => {
            const isLastTurn = ti === turns.length - 1;
            const turnRunning = isLastTurn && running;

            let bodyGroups: Group[];
            let trailingText: Entry | null = null;
            if (!turnRunning) {
              const bodyCopy = [...turn.body];
              for (let i = bodyCopy.length - 1; i >= 0; i--) {
                if (bodyCopy[i].kind === 'text') {
                  trailingText = bodyCopy[i];
                  bodyCopy.splice(i, 1);
                  break;
                }
              }
              bodyGroups = makeGroups(bodyCopy);
            } else {
              bodyGroups = makeGroups(turn.body);
            }

            const hasProcess = bodyGroups.length > 0;
            const processSummary = (() => {
              const toolCount = bodyGroups.reduce((s, g) => s + (g.kind === 'group' ? g.tools.length : 0), 0);
              const thinkingCount = bodyGroups.filter((g) => g.kind === 'item' && g.entry.kind === 'thinking').length;
              const textCount = bodyGroups.filter((g) => g.kind === 'item' && g.entry.kind === 'text').length;
              const parts: string[] = [];
              if (thinkingCount) parts.push(t('feed_thinking_segments', { n: thinkingCount }));
              if (toolCount) parts.push(t('feed_tool_count', { n: toolCount }));
              if (textCount) parts.push(t('feed_reply_segments', { n: textCount }));
              return t('feed_process_label', { n: parts.join(' · ') || ('0 ' + t('feed_step')) });
            })();

            const aiTracker = { shown: false };

            return (
              <div key={ti} style={{ display: 'contents' }}>
                {turn.user && turn.user.kind === 'user' && (
                  <div className="msg-wrap user">
                    <div className="msg user">{turn.user.text}</div>
                    <CopyBtn text={turn.user.text} />
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
        <button className="scroll-fab" onClick={jumpToBottom}>↓ {t('feed_new_message')}</button>
      )}
      <div className="composer">
        <div className="composer-modebar">
          <label className={`chip mode`} title={t(currentMode.labelKey)}>
            <span>{currentMode.icon}</span>
            <select
              value={settings.mode || 'auto'}
              onChange={(e) => updateSettings({ mode: e.target.value as ExecMode })}
            >
              {MODE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
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
                  updateSettings({ model: e.target.value, vision: defaultVisionForProvider(settings.provider || 'auto', e.target.value) });
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
            <span
              className={`vision-pill ${
                currentVision === true ? 'vision-on' : currentVision === false ? 'vision-off' : 'vision-unknown'
              }`}
              title={t('settings_vision_note')}
            >
              {visionLabel}
            </span>
            <div className="toolbar-spacer" />
            {running
              ? <button className="stop-fab" onClick={stop} title={t('input_stop')}>■</button>
              : <button className="send-fab" onClick={submit} disabled={!draft.trim() || !connected} title={`${t('input_send')} (⌘↩)`}>
                  {theme === 'synthwave' ? <>SEND <span className="send-arrow">▸</span></> : '›'}
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

function ToolRow({ t: entry, index }: { t: Entry & { kind: 'tool' }; index?: number }) {
  const [open, setOpen] = useState(false);
  const { t } = useT();
  const badgeText = entry.status === 'pending' ? 'RUN' : entry.status === 'ok' ? 'DONE' : 'ERR';
  const fullArgs = (() => { try { return JSON.stringify(entry.args, null, 2); } catch { return ''; } })();
  const resultText = (() => {
    if (entry.status === 'error') return entry.error || '';
    if (entry.status === 'ok') {
      try { const s = JSON.stringify(entry.result, null, 2) ?? ''; return s.length > 2000 ? s.slice(0, 2000) + `\n... (${s.length} chars)` : s; } catch { return ''; }
    }
    return '';
  })();
  const hasDetail = !!(resultText || fullArgs);
  const num = typeof index === 'number' ? `[${String(index).padStart(2, '0')}]` : '';
  return (
    <>
      <div className="tool-row" title={fullArgs}>
        {num && <span className="tool-num">{num}</span>}
        <span className="tool-name">{entry.tool}</span>
        <span className="tool-args">{shortArgs(entry.args)}</span>
        <span className={`tool-badge ${entry.status}`}>{badgeText}</span>
        {hasDetail && entry.status !== 'pending' && (
          <button className="tool-toggle" onClick={() => setOpen((v) => !v)} title={open ? t('feed_collapse') : t('feed_expand')}>{open ? '▾' : '▸'}</button>
        )}
      </div>
      {open && resultText && (
        <div className={`tool-result ${entry.status === 'error' ? 'error' : ''}`}>{resultText}</div>
      )}
    </>
  );
}
