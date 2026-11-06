import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * A minimal Chrome DevTools Protocol client over the browser-level WebSocket (flattened sessions) — the same shape as
 * server/src/spotify/cdp.ts, kept here so the engine has no dependency on the app's sources.
 */
export class Cdp extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    super();
    this.setMaxListeners(100);
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.shutdown(new Error('DevTools connection closed')));
    ws.on('error', (e) => this.shutdown(e instanceof Error ? e : new Error(String(e))));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: timeoutMs, perMessageDeflate: false });
      ws.once('open', () => resolve(new Cdp(ws)));
      ws.once('error', reject);
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('DevTools connection closed'));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close(): void {
    this.shutdown(new Error('closed'));
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'DevTools error'));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.emit('event', msg.method, msg.params ?? {}, msg.sessionId);
  }

  private shutdown(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('close');
  }
}
