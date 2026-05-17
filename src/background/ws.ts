import type { ClientMessage, ServerMessage } from '../types/messages';

const WS_URL = 'ws://127.0.0.1:8642/api/ws/extension';
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

type Listener = (msg: ServerMessage) => void;

export class HermesWS {
  private ws: WebSocket | null = null;
  private retry = 0;
  private listeners = new Set<Listener>();
  private connected = false;
  private closing = false;

  start() {
    this.closing = false;
    this.connect();
  }

  stop() {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  isConnected() {
    return this.connected;
  }

  send(msg: ClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Hermes WS] 发送失败：未连接', msg);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect() {
    try {
      this.ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[Hermes WS] 创建连接失败', e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[Hermes WS] 已连接');
      this.connected = true;
      this.retry = 0;
      this.send({ type: 'hello', client: 'chrome-extension', version: '0.1.0' });
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        this.listeners.forEach((l) => l(msg));
      } catch (e) {
        console.error('[Hermes WS] 解析消息失败', ev.data, e);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (!this.closing) {
        console.log('[Hermes WS] 断连，准备重试');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (e) => {
      console.error('[Hermes WS] 错误', e);
    };
  }

  private scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(this.retry, RECONNECT_DELAYS.length - 1)];
    this.retry++;
    setTimeout(() => {
      if (!this.closing) this.connect();
    }, delay);
  }
}

export const ws = new HermesWS();
