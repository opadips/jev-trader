/**
 * Reference prices: best bid/ask for MON on centralized exchanges, over their public WebSockets.
 *
 * Liquidity for MON is mostly off Kuru, so these venues usually move first. Whether they do, and by
 * how much, is exactly what the analyzer measures; nothing here assumes it. A venue that does not
 * list the symbol just never produces a quote, and /health shows it as silent.
 *
 * Each adapter is a URL, an optional subscribe message, an optional keepalive, and a pure `parse`
 * (tested in ref.test.ts) that turns one message into a quote or null.
 */
import type { VenueSpec } from "./config";

export interface Quote { bid: number; ask: number; bidSize: number; askSize: number }
export interface VenueQuote extends Quote { ts: number }
/** Latest quote per venue at the moment a Kuru book row was recorded. `ts` is our receive time. */
export type RefSnapshot = Record<string, VenueQuote>;

interface Adapter {
  url(symbol: string): string;
  /**
   * The venue sends a message whenever its best bid/ask changes, so while the socket is alive a
   * quiet feed means the last quote is still current. False for feeds that only speak on trades.
   */
  pushesChanges: boolean;
  subscribe?(symbol: string): unknown;
  /** Text to send every `pingMs` to keep the socket alive (the venue drops idle connections). */
  ping?: { every: number; message: string };
  /** One message in, a full top-of-book out, or null. `prev` lets one-sided updates keep the other side. */
  parse(msg: unknown, prev: Quote | null): Quote | null;
}

const num = (x: unknown) => (typeof x === "string" || typeof x === "number" ? Number(x) : NaN);
const valid = (q: Quote) => q.bid > 0 && q.ask > 0 && q.ask >= q.bid && Number.isFinite(q.bid + q.ask + q.bidSize + q.askSize);
const done = (q: Quote) => (valid(q) ? q : null);

export const ADAPTERS: Record<string, Adapter> = {
  /** bookTicker: every best bid/ask change. {"u":1,"s":"MONUSDT","b":"0.0226","B":"100","a":"0.0227","A":"50"} */
  binance: {
    url: (s) => `wss://stream.binance.com:9443/ws/${s.toLowerCase()}@bookTicker`,
    pushesChanges: true,
    parse(m: any) {
      if (!m || m.b === undefined || m.a === undefined) return null;
      return done({ bid: num(m.b), ask: num(m.a), bidSize: num(m.B), askSize: num(m.A) });
    },
  },
  /** orderbook.1: {"topic":"orderbook.1.MONUSDT","type":"snapshot"|"delta","data":{"b":[["p","q"]],"a":[["p","q"]]}} */
  bybit: {
    url: () => "wss://stream.bybit.com/v5/public/spot",
    pushesChanges: true,
    subscribe: (s) => ({ op: "subscribe", args: [`orderbook.1.${s}`] }),
    ping: { every: 20_000, message: JSON.stringify({ op: "ping" }) },
    parse(m: any, prev) {
      if (!m?.topic?.startsWith("orderbook.1.") || !m.data) return null;
      const b = m.data.b?.[0], a = m.data.a?.[0];
      const q: Quote = {
        bid: b ? num(b[0]) : prev?.bid ?? NaN, bidSize: b ? num(b[1]) : prev?.bidSize ?? NaN,
        ask: a ? num(a[0]) : prev?.ask ?? NaN, askSize: a ? num(a[1]) : prev?.askSize ?? NaN,
      };
      if (q.bidSize === 0 || q.askSize === 0) return null; // a level removed with no replacement in this message
      return done(q);
    },
  },
  /** bbo-tbt: {"arg":{...},"data":[{"asks":[["p","q","0","n"]],"bids":[["p","q","0","n"]],"ts":"..."}]}. Pings are the bare text "ping". */
  okx: {
    url: () => "wss://ws.okx.com:8443/ws/v5/public",
    pushesChanges: true,
    subscribe: (s) => ({ op: "subscribe", args: [{ channel: "bbo-tbt", instId: s }] }),
    ping: { every: 25_000, message: "ping" },
    parse(m: any) {
      const d = m?.data?.[0];
      if (m?.arg?.channel !== "bbo-tbt" || !d?.bids?.[0] || !d?.asks?.[0]) return null;
      return done({ bid: num(d.bids[0][0]), bidSize: num(d.bids[0][1]), ask: num(d.asks[0][0]), askSize: num(d.asks[0][1]) });
    },
  },
  /** ticker (sent on every trade): {"type":"ticker","best_bid":"..","best_bid_size":"..","best_ask":"..","best_ask_size":".."} */
  coinbase: {
    url: () => "wss://ws-feed.exchange.coinbase.com",
    pushesChanges: false,
    subscribe: (s) => ({ type: "subscribe", product_ids: [s], channels: ["ticker"] }),
    parse(m: any) {
      if (m?.type !== "ticker" || m.best_bid === undefined) return null;
      return done({ bid: num(m.best_bid), ask: num(m.best_ask), bidSize: num(m.best_bid_size), askSize: num(m.best_ask_size) });
    },
  },
};

export interface VenueStatus { venue: string; symbol: string; connected: boolean; messages: number; quotes: number; lastQuoteTs: number | null; lastMessageTs: number | null; lastError: string | null }

/** How long a live socket may stay quiet (keepalive replies included) before its last quote stops counting as current. */
export const QUIET_OK_MS = 30_000;

/**
 * When a quote was last known to be current. For venues that push every change, a connected socket
 * that has spoken recently (quotes or keepalive replies) vouches for the last quote up to now.
 */
export function currentAsOf(q: VenueQuote, st: Pick<VenueStatus, "connected" | "lastMessageTs">, pushesChanges: boolean, now: number): number {
  if (pushesChanges && st.connected && st.lastMessageTs !== null && now - st.lastMessageTs <= QUIET_OK_MS) return now;
  return q.ts;
}

/**
 * Keeps one socket per venue, reconnecting with backoff. `onTick` fires on every new quote so the
 * recorder can store (throttled) ticks; `snapshot()` is what gets attached to each Kuru book row.
 */
export class RefFeed {
  private latest = new Map<string, VenueQuote>();
  private status = new Map<string, VenueStatus>();
  private sockets = new Map<string, WebSocket>();
  private stopped = false;

  constructor(private venues: VenueSpec[], private onTick: (venue: string, q: VenueQuote) => void = () => {}) {
    for (const v of venues) this.status.set(v.venue, { ...v, connected: false, messages: 0, quotes: 0, lastQuoteTs: null, lastMessageTs: null, lastError: null });
  }

  start() {
    for (const v of this.venues) {
      if (!ADAPTERS[v.venue]) { this.status.get(v.venue)!.lastError = "unknown venue"; continue; }
      this.connect(v, 0);
    }
  }

  stop() {
    this.stopped = true;
    for (const ws of this.sockets.values()) ws.close();
  }

  /** Latest quote per venue; `ts` is when it was last known to be current, so consumers can drop stale ones. */
  snapshot(now = Date.now()): RefSnapshot {
    return Object.fromEntries([...this.latest].map(([k, q]) => [k, { ...q, ts: currentAsOf(q, this.status.get(k)!, ADAPTERS[k]?.pushesChanges ?? false, now) }]));
  }

  statuses(): VenueStatus[] { return [...this.status.values()]; }

  private connect(v: VenueSpec, delay: number) {
    const a = ADAPTERS[v.venue]!, st = this.status.get(v.venue)!;
    setTimeout(() => {
      if (this.stopped) return;
      let ping: ReturnType<typeof setInterval> | null = null;
      const ws = new WebSocket(a.url(v.symbol));
      this.sockets.set(v.venue, ws);
      ws.onopen = () => {
        st.connected = true; delay = 0;
        if (a.subscribe) ws.send(JSON.stringify(a.subscribe(v.symbol)));
        if (a.ping) ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(a.ping!.message), a.ping.every);
      };
      ws.onmessage = (e) => {
        st.messages++; st.lastMessageTs = Date.now();
        let m: unknown;
        try { m = JSON.parse(String(e.data)); } catch { return; } // "pong" and other keepalive text
        const prev = this.latest.get(v.venue) ?? null;
        const q = a.parse(m, prev);
        if (!q) {
          const err = (m as any)?.msg ?? (m as any)?.message ?? (m as any)?.ret_msg;
          if ((m as any)?.event === "error" || (m as any)?.type === "error" || (m as any)?.success === false) st.lastError = String(err ?? "error");
          return;
        }
        if (prev && prev.bid === q.bid && prev.ask === q.ask && prev.bidSize === q.bidSize && prev.askSize === q.askSize) return;
        const vq = { ...q, ts: Date.now() };
        this.latest.set(v.venue, vq);
        st.quotes++; st.lastQuoteTs = vq.ts;
        this.onTick(v.venue, vq);
      };
      ws.onerror = () => { st.lastError = "socket error"; };
      ws.onclose = () => {
        st.connected = false;
        if (ping) clearInterval(ping);
        if (!this.stopped) this.connect(v, Math.min(Math.max(delay * 2, 1000), 30_000));
      };
    }, delay);
  }
}

/** Median of the fresh venues' mids, or null. Robust to one venue being off or quoting in USD vs USDT. */
export function consensusMid(ref: RefSnapshot, now: number, maxAgeMs = 2000): number | null {
  const mids = Object.values(ref).filter((q) => now - q.ts <= maxAgeMs).map((q) => (q.bid + q.ask) / 2).sort((a, b) => a - b);
  if (!mids.length) return null;
  const k = mids.length >> 1;
  return mids.length % 2 ? mids[k]! : (mids[k - 1]! + mids[k]!) / 2;
}
