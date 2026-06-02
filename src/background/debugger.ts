// CDP (chrome.debugger) 封装：截图 / 鼠标 / 键盘 / 滚轮 / 对话框
// 设计原则：每个方法 attach 自动管理，调用方不感知 attach/detach 细节

const ATTACHED = new Set<number>();
const TAB_NETWORK_RING = new Map<number, NetworkLogRecord[]>();
const TAB_NETWORK_REQUESTS = new Map<number, Map<string, NetworkLogRecord>>();
const TAB_CONSOLE_RING = new Map<number, ConsoleLogRecord[]>();
const MAX_RING_SIZE = 200;

type HeaderValueMap = Record<string, string>;
type RemoteHeader = { name?: string; value?: string };
type CdpHeaderLike = HeaderValueMap | Array<RemoteHeader> | Array<[string, string]> | unknown;

type NetworkLogRecord = {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  type?: string;
  resourceType?: string;
  requestHeaders?: HeaderValueMap;
  responseHeaders?: HeaderValueMap;
  mimeType?: string;
  fromCache?: boolean;
  errorText?: string;
  durationMs?: number;
  hasResponseBody?: boolean;
  requestStart?: number;
  responseStart?: number;
  responseEnd?: number;
};

type ConsoleLogRecord = {
  timestamp: number;
  level: 'all' | 'log' | 'info' | 'warn' | 'error' | 'debug';
  source: string;
  text: string;
  argsPreview: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: unknown;
};

function pushRing<T>(store: Map<number, T[]>, tabId: number, value: T) {
  const list = store.get(tabId) ?? [];
  list.push(value);
  if (list.length > MAX_RING_SIZE) list.shift();
  store.set(tabId, list);
}

function coerceHeaders(raw: CdpHeaderLike): HeaderValueMap {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: HeaderValueMap = {};
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string' && typeof item[1] === 'string') {
        out[item[0].toLowerCase()] = item[1];
      } else if (item && typeof item === 'object' && typeof item.name === 'string' && typeof item.value === 'string') {
        out[item.name.toLowerCase()] = item.value;
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out: HeaderValueMap = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key.toLowerCase()] = value;
    }
    return out;
  }
  return {};
}

function sanitizeHeaders(headers: HeaderValueMap): HeaderValueMap {
  const redacted = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'proxy-authorization',
  ]);
  const out: HeaderValueMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    out[key] = redacted.has(key) ? '[redacted]' : value;
  }
  return out;
}

function formatRemoteObjectPreview(v: unknown): string {
  if (!v || typeof v !== 'object') return String(v);
  const obj = v as { value?: unknown; description?: string; unserializableValue?: string };
  if (obj.value != null) return String(obj.value);
  if (obj.description) return String(obj.description).slice(0, 800);
  if (obj.unserializableValue) return String(obj.unserializableValue);
  return JSON.stringify(v).slice(0, 800);
}

function logLevelFromRuntime(type: string): ConsoleLogRecord['level'] {
  const lowered = type.toLowerCase();
  if (lowered.includes('warn')) return 'warn';
  if (lowered.includes('error') || lowered.includes('exception') || lowered.includes('assert')) return 'error';
  if (lowered.includes('debug')) return 'debug';
  if (lowered.includes('info')) return 'info';
  return 'log';
}

function mapCdpLogLevel(level: string): ConsoleLogRecord['level'] {
  const lowered = String(level || '').toLowerCase();
  if (lowered === 'warning') return 'warn';
  if (lowered === 'error' || lowered === 'critical' || lowered === 'assert') return 'error';
  if (lowered === 'debug' || lowered === 'verbose') return 'debug';
  if (lowered === 'info') return 'info';
  return 'log';
}

function epochMillis(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Date.now();
  // Runtime.Timestamp / Log.Timestamp are normally epoch milliseconds. Accept
  // epoch seconds too, because CDP domains are not fully consistent here.
  return Math.round(value > 1_000_000_000_000 ? value : value * 1000);
}

function wallTimeMillis(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000);
}

function monotonicMillis(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value * 1000;
}

function normalizeCDPConsoleLog(item: ConsoleLogRecord): ConsoleLogRecord {
  return {
    timestamp: item.timestamp,
    level: item.level,
    source: item.source,
    text: item.text.slice(0, 8_000),
    argsPreview: item.argsPreview,
    url: item.url,
    lineNumber: item.lineNumber,
    columnNumber: item.columnNumber,
    stackTrace: item.stackTrace,
  };
}

function normalizeNetworkLogItem(item: NetworkLogRecord): NetworkLogRecord {
  return { ...item };
}

async function ensureAttached(tabId: number): Promise<void> {
  if (ATTACHED.has(tabId)) return;
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message?.includes('already attached')) {
        return reject(err);
      }
      ATTACHED.add(tabId);
      // 监听对话框，自动 accept；并启用 Network/Runtime/Log，给 console/network 工具提供事件 buffer
      chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
      chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => {});
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});
      chrome.debugger.sendCommand({ tabId }, 'Log.enable').catch(() => {});
      resolve();
    });
  });
}

async function send<T = unknown>(tabId: number, method: string, params?: object, timeoutMs = 30_000): Promise<T> {
  await ensureAttached(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP call ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(result as T);
    });
  });
}

export async function detach(tabId: number) {
  if (!ATTACHED.has(tabId)) return;
  return new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      ATTACHED.delete(tabId);
      TAB_NETWORK_RING.delete(tabId);
      TAB_NETWORK_REQUESTS.delete(tabId);
      TAB_CONSOLE_RING.delete(tabId);
      resolve();
    });
  });
}

// 自动清理
chrome.tabs.onRemoved.addListener((tabId) => {
  ATTACHED.delete(tabId);
  TAB_NETWORK_RING.delete(tabId);
  TAB_NETWORK_REQUESTS.delete(tabId);
  TAB_CONSOLE_RING.delete(tabId);
});
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId) ATTACHED.delete(src.tabId);
  if (src.tabId) {
    TAB_NETWORK_RING.delete(src.tabId);
    TAB_NETWORK_REQUESTS.delete(src.tabId);
    TAB_CONSOLE_RING.delete(src.tabId);
  }
});

// 自动处理 JS Dialog
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!src.tabId) return;
  const tabId = src.tabId;
  if (method === 'Page.javascriptDialogOpening') {
    chrome.debugger
      .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true })
      .catch(() => {});
    return;
  }

  if (!ATTACHED.has(tabId)) return;

  if (method === 'Network.requestWillBeSent') {
    const payload = params as {
      requestId?: string;
      request?: { method?: string; url?: string; headers?: CdpHeaderLike };
      type?: string;
      resourceType?: string;
      timestamp?: number;
      wallTime?: number;
    };
    const requestId = payload.requestId;
    if (!requestId) return;
    const entry: NetworkLogRecord = {
      id: requestId,
      timestamp: wallTimeMillis(payload.wallTime) ?? Date.now(),
      method: (payload.request?.method || 'GET').toUpperCase(),
      url: payload.request?.url || '',
      type: payload.type,
      resourceType: payload.resourceType,
      requestHeaders: payload.request?.headers ? coerceHeaders(payload.request.headers) : {},
      requestStart: monotonicMillis(payload.timestamp) ?? Date.now(),
      fromCache: false,
      hasResponseBody: false,
    };
    const bucket = TAB_NETWORK_REQUESTS.get(tabId) ?? new Map<string, NetworkLogRecord>();
    bucket.set(requestId, entry);
    TAB_NETWORK_REQUESTS.set(tabId, bucket);
    pushRing(TAB_NETWORK_RING, tabId, entry);
    return;
  }

  if (method === 'Network.responseReceived') {
    const payload = params as {
      requestId?: string;
      response?: {
        status?: number;
        headers?: CdpHeaderLike;
        mimeType?: string;
        fromDiskCache?: boolean;
      };
      type?: string;
      resourceType?: string;
      timestamp?: number;
      encodedDataLength?: number;
    };
    const requestId = payload.requestId;
    if (!requestId) return;
    const bucket = TAB_NETWORK_REQUESTS.get(tabId);
    if (!bucket) return;
    const entry = bucket.get(requestId);
    if (!entry) return;
    if (typeof payload.response?.status === 'number') entry.status = payload.response.status;
    if (payload.response?.headers) entry.responseHeaders = coerceHeaders(payload.response.headers);
    if (payload.response?.mimeType) entry.mimeType = payload.response.mimeType;
    if (typeof payload.response?.fromDiskCache === 'boolean') entry.fromCache = payload.response.fromDiskCache;
    if (payload.resourceType) entry.resourceType = payload.resourceType;
    if (payload.type) entry.type = payload.type;
    entry.responseStart = monotonicMillis(payload.timestamp) ?? Date.now();
    entry.hasResponseBody = true;
    return;
  }

  if (method === 'Network.loadingFinished') {
    const payload = params as { requestId?: string; requestIdStr?: string; timestamp?: number };
    const requestId = payload.requestId ?? payload.requestIdStr;
    if (!requestId) return;
    const bucket = TAB_NETWORK_REQUESTS.get(tabId);
    if (!bucket) return;
    const entry = bucket.get(requestId);
    if (!entry) return;
    const end = monotonicMillis(payload.timestamp) ?? Date.now();
    if (entry.requestStart != null) {
      entry.durationMs = end - entry.requestStart;
      entry.responseEnd = end;
    }
    bucket.delete(requestId);
    if (bucket.size === 0) TAB_NETWORK_REQUESTS.delete(tabId);
    return;
  }

  if (method === 'Network.loadingFailed') {
    const payload = params as { requestId?: string; errorText?: string; timestamp?: number; cancelled?: boolean };
    const requestId = payload.requestId;
    if (!requestId) return;
    const bucket = TAB_NETWORK_REQUESTS.get(tabId);
    if (!bucket) return;
    const entry = bucket.get(requestId);
    if (!entry) return;
    const err = payload.errorText || (payload.cancelled ? 'Request cancelled' : 'Request failed');
    entry.errorText = err;
    if (!entry.hasResponseBody) entry.hasResponseBody = false;
    if (payload.timestamp) {
      const failedAt = monotonicMillis(payload.timestamp) ?? Date.now();
      entry.durationMs = failedAt - (entry.requestStart ?? failedAt);
    }
    bucket.delete(requestId);
    if (bucket.size === 0) TAB_NETWORK_REQUESTS.delete(tabId);
    return;
  }

  if (method === 'Runtime.consoleAPICalled') {
    const payload = params as {
      type?: string;
      args?: Array<{ value?: unknown; description?: string; unserializableValue?: string }>;
      timestamp?: number;
      stackTrace?: unknown;
    };
    const args = Array.isArray(payload.args) ? payload.args : [];
    const argsPreview = args.map(formatRemoteObjectPreview).join(' ');
    const level = logLevelFromRuntime(String(payload.type || 'log'));
    pushRing(
      TAB_CONSOLE_RING,
      tabId,
      normalizeCDPConsoleLog({
        timestamp: epochMillis(payload.timestamp),
        level,
        source: 'runtime',
        text: argsPreview || '[no args]',
        argsPreview,
        stackTrace: payload.stackTrace,
      }),
    );
    return;
  }

  if (method === 'Log.entryAdded') {
    const payload = params as {
      entry?: {
        level?: string;
        source?: string;
        text?: string;
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
        stackTrace?: unknown;
        timestamp?: number;
      };
    };
    const entry = payload.entry || {};
    const text = String(entry.text ?? '');
    pushRing(
      TAB_CONSOLE_RING,
      tabId,
      normalizeCDPConsoleLog({
        timestamp: epochMillis(entry.timestamp),
        level: mapCdpLogLevel(String(entry.level || 'info')),
        source: entry.source ? String(entry.source) : 'log',
        text,
        argsPreview: text,
        url: entry.url ? String(entry.url) : undefined,
        lineNumber: typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined,
        columnNumber: typeof entry.columnNumber === 'number' ? entry.columnNumber : undefined,
        stackTrace: entry.stackTrace,
      }),
    );
    return;
  }

  if (method === 'Runtime.exceptionThrown') {
    const payload = params as {
      exceptionDetails?: {
        text?: string;
        lineNumber?: number;
        columnNumber?: number;
        url?: string;
        stackTrace?: unknown;
      };
    };
    const detail = payload.exceptionDetails || {};
    const text = detail.text || 'Uncaught exception';
    pushRing(
      TAB_CONSOLE_RING,
      tabId,
      normalizeCDPConsoleLog({
        timestamp: Date.now(),
        level: 'error',
        source: 'exception',
        text: String(text),
        argsPreview: String(text),
        url: detail.url,
        lineNumber: typeof detail.lineNumber === 'number' ? detail.lineNumber : undefined,
        columnNumber: typeof detail.columnNumber === 'number' ? detail.columnNumber : undefined,
        stackTrace: detail.stackTrace,
      }),
    );
  }
});

// === 工具方法 ===

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale?: number };

export async function screenshot(tabId: number, format: 'jpeg' | 'png' = 'jpeg', clip?: ScreenshotClip) {
  const result = await send<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? 55 : undefined,
    fromSurface: true,
    captureBeyondViewport: !!clip,
    ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}),
  });
  return { data: result.data, format, mimeType: `image/${format}` };
}

export async function mouseClick(tabId: number, x: number, y: number, button: 'left' | 'right' = 'left', clickCount = 1) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
}

export async function mouseMove(tabId: number, x: number, y: number) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function mouseDown(tabId: number, x: number, y: number, button: 'left' | 'middle' | 'right' = 'left') {
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, buttons });
}

export async function mouseUp(tabId: number, x: number, y: number, button: 'left' | 'middle' | 'right' = 'left') {
  const buttons = button === 'left' ? 0 : button === 'right' ? 0 : 0;
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, buttons });
}

export async function mouseWheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

export async function insertText(tabId: number, text: string) {
  await send(tabId, 'Input.insertText', { text });
}

export async function typeTextByKeyEvents(tabId: number, text: string, delayMs = 0) {
  for (const ch of Array.from(text)) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      key: ch,
      text: ch,
      unmodifiedText: ch,
    });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function pressKey(tabId: number, key: string, code?: string, modifiers = 0) {
  const mods: Array<{ k: string; c: string; f: number }> = [];
  if (modifiers & 1) mods.push({ k: 'Alt',     c: 'AltLeft',     f: 1 });
  if (modifiers & 2) mods.push({ k: 'Control', c: 'ControlLeft', f: 2 });
  if (modifiers & 4) mods.push({ k: 'Meta',    c: 'MetaLeft',    f: 4 });
  if (modifiers & 8) mods.push({ k: 'Shift',   c: 'ShiftLeft',   f: 8 });

  let acc = 0;
  for (const m of mods) {
    acc |= m.f;
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: m.k, code: m.c, modifiers: acc });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: code ?? key, modifiers });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key, code: code ?? key, modifiers });
  for (let i = mods.length - 1; i >= 0; i--) {
    acc &= ~mods[i].f;
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: mods[i].k, code: mods[i].c, modifiers: acc });
  }
}

export async function evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
  const r = await send<{ result: { value?: T } }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return r.result.value as T;
}

// CDP commands:['Paste'] 走 Chromium 编辑器命令路径，等价于真实 Cmd+V，
// 会触发 paste 事件并把剪贴板内容塞给 focused editable。
// 单纯 Input.dispatchKeyEvent 模拟 Cmd+V 不会走这条路径（X/ProseMirror 拿不到文本）。
export async function paste(tabId: number) {
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'v',
    code: 'KeyV',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 4,
    commands: ['Paste'],
  });
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'v',
    code: 'KeyV',
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 4,
  });
}

export async function readConsoleLogs(
  tabId: number,
  level: 'all' | 'log' | 'info' | 'warn' | 'error' | 'debug' = 'all',
  limit = 200,
) {
  await ensureAttached(tabId);
  const lim = Math.max(1, Math.min(200, limit));
  const entries = TAB_CONSOLE_RING.get(tabId) || [];
  const filtered = level === 'all' ? entries : entries.filter((x) => x.level === level);
  return filtered.slice(-lim).map((item) => ({
    timestamp: item.timestamp,
    level: item.level,
    source: item.source,
    text: item.text,
    argsPreview: item.argsPreview,
    url: item.url,
    lineNumber: item.lineNumber,
    columnNumber: item.columnNumber,
    stackTrace: item.stackTrace,
  }));
}

function applyNetworkFilter(entries: NetworkLogRecord[], filter?: string) {
  if (!filter) return entries;
  const term = filter.toLowerCase();
  return entries.filter((entry) => {
    const hay = `${entry.id} ${entry.method} ${entry.url} ${entry.type || ''} ${entry.resourceType || ''}`.toLowerCase();
    return hay.includes(term);
  });
}

function isFailedNetworkRequest(entry: NetworkLogRecord): boolean {
  if (entry.errorText) return true;
  if (typeof entry.status === 'number' && entry.status >= 400) return true;
  return false;
}

export async function readNetworkRequests(
  tabId: number,
  args: {
    filter?: string;
    includeHeaders?: boolean;
    includeFailed?: boolean;
    includeBody?: boolean;
    limit?: number;
  },
): Promise<Array<{
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  type?: string;
  resourceType?: string;
  requestHeaders?: HeaderValueMap;
  responseHeaders?: HeaderValueMap;
  mimeType?: string;
  fromCache?: boolean;
  errorText?: string;
  durationMs?: number;
  body?: {
    body: string;
    truncated: boolean;
    encoding: 'utf8' | 'base64';
    _byte_limit: number;
  };
}>> {
  await ensureAttached(tabId);
  const lim = Math.max(1, Math.min(200, args.limit ?? 200));
  const includeHeaders = !!args.includeHeaders;
  const includeFailed = !!args.includeFailed;
  const includeBody = !!args.includeBody;
  const network = TAB_NETWORK_RING.get(tabId) || [];

  const filtered = applyNetworkFilter(network, args.filter).filter((entry) => {
    if (includeFailed) return true;
    return !isFailedNetworkRequest(entry);
  });
  const selected = filtered.slice(-lim).map(normalizeNetworkLogItem);

  if (!includeBody) {
    return selected.map((entry) => {
      const { id, timestamp, method, url } = entry;
      return {
        id,
        timestamp,
        method,
        url,
        status: entry.status,
        type: entry.type,
        resourceType: entry.resourceType,
        requestHeaders: includeHeaders && entry.requestHeaders ? sanitizeHeaders(entry.requestHeaders) : undefined,
        responseHeaders: includeHeaders && entry.responseHeaders ? sanitizeHeaders(entry.responseHeaders) : undefined,
        mimeType: entry.mimeType,
        fromCache: entry.fromCache,
        errorText: entry.errorText,
        durationMs: entry.durationMs,
      };
    });
  }

  const withBodyLimit = 4096;
  const out: Array<any> = [];
  for (const entry of selected) {
    let body: { body: string; truncated: boolean; encoding: 'utf8' | 'base64'; _byte_limit: number } | undefined;
    if (entry.hasResponseBody) {
      try {
        const raw = await send<{ body?: string; base64Encoded?: boolean }>(tabId, 'Network.getResponseBody', { requestId: entry.id });
        const payload = raw?.body || '';
        const encoding: 'utf8' | 'base64' = raw?.base64Encoded ? 'base64' : 'utf8';
        body = {
          body: payload.slice(0, withBodyLimit),
          truncated: payload.length > withBodyLimit,
          encoding,
          _byte_limit: withBodyLimit,
        };
      } catch {
        body = {
          body: '',
          truncated: false,
          encoding: 'utf8',
          _byte_limit: withBodyLimit,
        };
      }
    }
    out.push({
      id: entry.id,
      timestamp: entry.timestamp,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      type: entry.type,
      resourceType: entry.resourceType,
      requestHeaders: includeHeaders && entry.requestHeaders ? sanitizeHeaders(entry.requestHeaders) : undefined,
      responseHeaders: includeHeaders && entry.responseHeaders ? sanitizeHeaders(entry.responseHeaders) : undefined,
      mimeType: entry.mimeType,
      fromCache: entry.fromCache,
      errorText: entry.errorText,
      durationMs: entry.durationMs,
      body,
    });
  }

  return out;
}
