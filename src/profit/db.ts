import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RefSnapshot } from "./ref";

/** One Kuru book read. `bids`/`asks` are the top levels, best first, as [price, size]. */
export interface BookRow {
  block: number;
  ts: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  imbalance: number;
  bids: [number, number][];
  asks: [number, number][];
  depth: Record<string, { bid: number; ask: number }>;
  ref: RefSnapshot;
  readMs: number;
}

/** A taker print on Kuru. `side` is the taker's side. */
export interface TradeRow { block: number; logIndex: number; tx: string; side: "buy" | "sell"; price: number; size: number; maker: string; taker: string; orderId: number }

export interface RefTickRow { ts: number; venue: string; bid: number; ask: number; bidSize: number; askSize: number }

/** Up / down / flat forecast for `horizon` blocks after `block`. */
export interface PredictionRow {
  block: number;
  ts: number;
  model: string;
  horizon: number;
  flatBps: number;
  pUp: number;
  pDown: number;
  pFlat: number;
  choice: string;
  confidence: number | null;
  latencyMs: number;
  inputTokens: number;
  state: unknown;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS books (
  block INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bid REAL NOT NULL, ask REAL NOT NULL, mid REAL NOT NULL,
  spread_bps REAL NOT NULL, imbalance REAL NOT NULL, bids TEXT NOT NULL, asks TEXT NOT NULL, depth TEXT NOT NULL,
  ref TEXT NOT NULL, read_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
  size REAL NOT NULL, maker TEXT NOT NULL, taker TEXT NOT NULL, order_id INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS trades_block ON trades (block);
CREATE TABLE IF NOT EXISTS ref_ticks (
  ts INTEGER NOT NULL, venue TEXT NOT NULL, bid REAL NOT NULL, ask REAL NOT NULL, bid_size REAL NOT NULL, ask_size REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ref_ticks_venue_ts ON ref_ticks (venue, ts);
CREATE TABLE IF NOT EXISTS predictions (
  block INTEGER NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, horizon INTEGER NOT NULL, flat_bps REAL NOT NULL,
  p_up REAL NOT NULL, p_down REAL NOT NULL, p_flat REAL NOT NULL, choice TEXT NOT NULL, confidence REAL, latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, state TEXT NOT NULL, error TEXT,
  PRIMARY KEY (block, model, horizon)
);
`;

/**
 * The research store. Writes are queued and flushed in one transaction every `flushMs`, so the
 * block loop never waits on disk. WAL mode lets the analyzer read while the recorder writes.
 */
export class Store {
  readonly db: Database;
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private insBook; private insTrade; private insTick; private insPred;

  constructor(path: string, opts: { readonly?: boolean; flushMs?: number } = {}) {
    if (path !== ":memory:" && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
    if (!opts.readonly) {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.db.exec(SCHEMA);
    }
    this.insBook = opts.readonly ? null : this.db.prepare(
      "INSERT OR IGNORE INTO books VALUES ($block, $ts, $bid, $ask, $mid, $spread, $imb, $bids, $asks, $depth, $ref, $readMs)");
    this.insTrade = opts.readonly ? null : this.db.prepare(
      "INSERT OR IGNORE INTO trades VALUES ($block, $logIndex, $tx, $side, $price, $size, $maker, $taker, $orderId)");
    this.insTick = opts.readonly ? null : this.db.prepare(
      "INSERT INTO ref_ticks VALUES ($ts, $venue, $bid, $ask, $bidSize, $askSize)");
    this.insPred = opts.readonly ? null : this.db.prepare(
      "INSERT OR REPLACE INTO predictions VALUES ($block, $ts, $model, $horizon, $flatBps, $pUp, $pDown, $pFlat, $choice, $confidence, $latencyMs, $inputTokens, $state, $error)");
    if (!opts.readonly && opts.flushMs) this.timer = setInterval(() => this.flush(), opts.flushMs);
  }

  setMeta(key: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  meta(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all()) out[r.key] = JSON.parse(r.value);
    return out;
  }

  addBook(b: BookRow) {
    this.queue.push(() => this.insBook!.run({
      $block: b.block, $ts: b.ts, $bid: b.bid, $ask: b.ask, $mid: b.mid, $spread: b.spreadBps, $imb: b.imbalance,
      $bids: JSON.stringify(b.bids), $asks: JSON.stringify(b.asks), $depth: JSON.stringify(b.depth), $ref: JSON.stringify(b.ref), $readMs: b.readMs,
    }));
  }

  addTrade(t: TradeRow) {
    this.queue.push(() => this.insTrade!.run({
      $block: t.block, $logIndex: t.logIndex, $tx: t.tx, $side: t.side, $price: t.price, $size: t.size, $maker: t.maker, $taker: t.taker, $orderId: t.orderId,
    }));
  }

  addTick(t: RefTickRow) {
    this.queue.push(() => this.insTick!.run({ $ts: t.ts, $venue: t.venue, $bid: t.bid, $ask: t.ask, $bidSize: t.bidSize, $askSize: t.askSize }));
  }

  addPrediction(p: PredictionRow) {
    this.queue.push(() => this.insPred!.run({
      $block: p.block, $ts: p.ts, $model: p.model, $horizon: p.horizon, $flatBps: p.flatBps, $pUp: p.pUp, $pDown: p.pDown, $pFlat: p.pFlat,
      $choice: p.choice, $confidence: p.confidence, $latencyMs: p.latencyMs, $inputTokens: p.inputTokens, $state: JSON.stringify(p.state), $error: p.error,
    }));
  }

  /** Write everything queued in one transaction. Returns the number of rows written. */
  flush(): number {
    if (!this.queue.length) return 0;
    const q = this.queue; this.queue = [];
    this.db.transaction(() => { for (const f of q) f(); })();
    return q.length;
  }

  count(table: "books" | "trades" | "ref_ticks" | "predictions"): number {
    return this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  // ---------------------------------------------------------------------------------------------
  // Reads for the analyzer (oldest first)

  /**
   * Book rows with ts >= `fromTs`. `lite` keeps only the best level per side and drops depth, which
   * is all the analyzer needs and cuts memory by ~3x on multi-day recordings.
   */
  books(opts: { fromTs?: number; lite?: boolean } = {}): BookRow[] {
    const { fromTs = 0, lite = false } = opts;
    return this.db.query<any, [number]>("SELECT * FROM books WHERE ts >= ? ORDER BY block").all(fromTs).map((r) => {
      const bids = JSON.parse(r.bids), asks = JSON.parse(r.asks);
      return {
        block: r.block, ts: r.ts, bid: r.bid, ask: r.ask, mid: r.mid, spreadBps: r.spread_bps, imbalance: r.imbalance,
        bids: lite ? bids.slice(0, 1) : bids, asks: lite ? asks.slice(0, 1) : asks, depth: lite ? {} : JSON.parse(r.depth), ref: JSON.parse(r.ref), readMs: r.read_ms,
      };
    });
  }

  lastTs(): number | null {
    return this.db.query<{ ts: number | null }, []>("SELECT MAX(ts) AS ts FROM books").get()?.ts ?? null;
  }

  trades(fromBlock = 0, toBlock = Number.MAX_SAFE_INTEGER): TradeRow[] {
    return this.db.query<any, [number, number]>("SELECT * FROM trades WHERE block >= ? AND block <= ? ORDER BY block, log_index").all(fromBlock, toBlock).map((r) => ({
      block: r.block, logIndex: r.log_index, tx: r.tx, side: r.side, price: r.price, size: r.size, maker: r.maker, taker: r.taker, orderId: r.order_id,
    }));
  }

  /** Forecasts from `fromBlock` on. The model's input `state` is only parsed when asked for (it is most of the row). */
  predictions(opts: { model?: string; fromBlock?: number; withState?: boolean } = {}): PredictionRow[] {
    const { model, fromBlock = 0, withState = false } = opts;
    const rows = model
      ? this.db.query<any, [number, string]>("SELECT * FROM predictions WHERE block >= ? AND model = ? ORDER BY block").all(fromBlock, model)
      : this.db.query<any, [number]>("SELECT * FROM predictions WHERE block >= ? ORDER BY block").all(fromBlock);
    return rows.map((r) => ({
      block: r.block, ts: r.ts, model: r.model, horizon: r.horizon, flatBps: r.flat_bps, pUp: r.p_up, pDown: r.p_down, pFlat: r.p_flat,
      choice: r.choice, confidence: r.confidence, latencyMs: r.latency_ms, inputTokens: r.input_tokens, state: withState ? JSON.parse(r.state) : null, error: r.error,
    }));
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    if (this.insBook) this.flush();
    this.db.close();
  }
}
