import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';

/**
 * Client for one user's Chromium inside the chromium container. The container runs one Chromium per user under
 * its own unix user and only exposes them through the manager (chromium/manager), which checks a per-instance
 * bearer token on every request. This user's token opens this user's instance only.
 *
 * Everything goes through the manager's relay: the DevTools HTTP endpoints (/json/version, /json/list) and the
 * browser-level WebSocket. Page-level endpoints and the inspector UI are not relayed.
 */
export interface CdpConnectOptions {
  browserWSEndpoint: string;
  headers: Record<string, string>;
}

/** Where the CDP relay of this user's browser is, and the headers that prove it may use it. */
export interface CdpTarget {
  /** HTTP base of the relay, e.g. http://chromium:9223/i/2/cdp */
  base: string;
  /** The instance's bearer token on every request (HTTP and the WebSocket handshake). */
  headers: Record<string, string>;
  /** The browser-level DevTools WebSocket behind the relay. */
  wsUrl: () => Promise<string>;
}

export class ChromiumLink {
  constructor(
    private readonly url: string,
    readonly instance: number,
    private readonly token: string | undefined,
  ) {}

  private get headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private path(suffix: string): string {
    return `${this.url}/i/${this.instance}${suffix}`;
  }

  /** Starts this user's Chromium if it is not running and waits until its DevTools endpoint answers. */
  async ensure(timeoutMs = 40_000): Promise<boolean> {
    try {
      const r = await fetch(this.path('/ensure'), { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Kills and restarts this user's browser (stuck page, lost display). */
  async restart(timeoutMs = 40_000): Promise<boolean> {
    try {
      const r = await fetch(this.path('/restart'), { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Shuts this user's browser down (the profile and the Spotify login stay); ensure() starts it again. */
  async stop(timeoutMs = 30_000): Promise<boolean> {
    try {
      const r = await fetch(this.path('/stop'), { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async reachable(timeoutMs = 3000): Promise<boolean> {
    try {
      const r = await fetch(this.path('/cdp/json/version'), { headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** The raw CDP relay target used by spotify/session.ts (tab list, cookie jar). */
  cdpTarget(): CdpTarget {
    return { base: this.path('/cdp'), headers: this.headers, wsUrl: () => this.browserWsUrl() };
  }

  /** The browser-level WebSocket, rewritten onto the manager's relay (Chromium names its own loopback address). */
  private async browserWsUrl(): Promise<string> {
    const r = await fetch(this.path('/cdp/json/version'), { headers: this.headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('Chromium is not reachable yet');
    const info = (await r.json()) as { webSocketDebuggerUrl?: string };
    const wsUrl = info.webSocketDebuggerUrl;
    if (typeof wsUrl !== 'string') throw new Error('Chromium is not reachable yet');
    const devtoolsPath = new URL(wsUrl).pathname;
    if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(devtoolsPath)) throw new Error('Chromium returned an unexpected DevTools path');
    const u = new URL(this.path(`/cdp${devtoolsPath}`));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  /** puppeteer.connect() options: the browser-level DevTools WebSocket behind the manager's authenticated relay. */
  async connectOptions(): Promise<CdpConnectOptions> {
    const r = await fetch(this.path('/cdp/json/version'), { headers: this.headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('Chromium is not reachable yet');
    const info = (await r.json()) as { webSocketDebuggerUrl?: string };
    const wsUrl = info.webSocketDebuggerUrl;
    if (typeof wsUrl !== 'string') throw new Error('Chromium is not reachable yet');
    const devtoolsPath = new URL(wsUrl).pathname;
    if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(devtoolsPath)) throw new Error('Chromium returned an unexpected DevTools path');
    const u = new URL(this.path(`/cdp${devtoolsPath}`));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return { browserWSEndpoint: u.toString(), headers: this.headers };
  }

  /** The VNC password of this user's virtual screen (random per browser start, only this user's token reads it). */
  async vncPassword(): Promise<string> {
    const r = await fetch(this.path('/vnc-password'), { headers: this.headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('VNC is not available');
    const body = (await r.json()) as { password?: unknown };
    if (typeof body.password !== 'string') throw new Error('VNC is not available');
    return body.password;
  }

  /** A raw byte tunnel to this user's x11vnc (HTTP Upgrade: rdf-tunnel — chromium/manager/server.go checks this
   *  exact value *and* the token; the two must stay in sync, and the Go tests pin the same string). */
  openVncTunnel(timeoutMs = 5000): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.path('/vnc'));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { headers: { ...this.headers, connection: 'Upgrade', upgrade: 'rdf-tunnel' }, timeout: timeoutMs });
      req.on('upgrade', (_res, socket, head) => {
        socket.setTimeout(0);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`VNC tunnel refused (${res.statusCode})`));
      });
      req.on('timeout', () => req.destroy(new Error('VNC tunnel timed out')));
      req.on('error', reject);
      req.end();
    });
  }
}
