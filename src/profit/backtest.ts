/**
 * Phase 2: replay the recording and simulate a strategy with the costs a real one would pay.
 *
 * Execution model (the same for every strategy):
 *   - A decision at row t only uses what was known at row t (book, reference quotes, forecasts).
 *   - Its transaction lands `latencyBlocks` later: the first row at or after block + latency.
 *     Taker orders fill against THAT row's book, walking the recorded levels; resting orders join
 *     THAT row's queue.
 *   - Every transaction pays `gasMon` (Monad charges the gas limit, reverted or not), converted
 *     at the mid of the row it lands in. Kuru fees come from the contract (0/0 on MON-USDC today).
 *   - Resting orders fill by price then time priority against the recorded taker prints: a print
 *     through our price fills us; a print at our price first eats the size queued ahead of us.
 *     Size ahead shrinks when the recorded level shrinks (cancels), never grows. A book that
 *     crosses our price also fills us. Our own orders never move the recorded market.
 *
 * Known optimism: we assume nobody else reacts to our orders, and the recorded prints would have
 * happened with us in the book. Paper trading (Phase 3) is where that gets checked.
 */
import type { BookRow, PredictionRow, TradeRow } from "./db";
import { fairValues } from "./analysis";
import { lowerBound, mean } from "./stats";

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;

export interface Costs { latencyBlocks: number; gasMon: number; takerFeeBps: number; makerFeeBps: number; tick: number }
export const DEFAULT_COSTS: Costs = { latencyBlocks: 1, gasMon: 0.036, takerFeeBps: 0, makerFeeBps: 0, tick: 1e-6 };

export interface Result {
  strategy: string;
  params: Record<string, unknown>;
  hours: number;
  pnlUsd: number;
  pnlPerHourUsd: number;
  gasUsd: number;
  feesUsd: number;
  txs: number;
  fills: number;
  volumeMon: number;
  /** Round trips (taker) or fills (maker) that made money after their share of costs. */
  winRate: number;
  /** Average result per round trip (taker) or per fill vs mid 33 rows later (maker), bps, after costs. */
  avgNetBps: number;
  maxDrawdownUsd: number;
  maxInventoryMon: number;
  endInventoryMon: number;
}

/** Index of the row the transaction decided at row t lands in, or -1 past the end of the recording. */
export function landing(books: BookRow[], t: number, latencyBlocks: number) {
  const target = books[t]!.block + Math.max(1, latencyBlocks);
  const j = lowerBound(books, target, (b) => b.block);
  return j < books.length ? j : -1;
}

/** Take up to `size` MON from the recorded levels (best first). Returns filled size and average price. */
export function walk(levels: [number, number][], size: number) {
  let left = size, cost = 0;
  for (const [p, s] of levels) {
    const q = Math.min(left, s);
    cost += q * p; left -= q;
    if (left <= 1e-9) break;
  }
  const qty = size - Math.max(0, left);
  return { qty, price: qty > 0 ? cost / qty : NaN };
}

/** Running account: cash in USDC, inventory in MON, equity marked at mid. */
class Account {
  cash = 0; inv = 0; gasUsd = 0; feesUsd = 0; txs = 0; fills = 0; volume = 0;
  peak = 0; maxDd = 0; maxInv = 0;
  tx(mid: number, c: Costs) { this.txs++; const g = c.gasMon * mid; this.gasUsd += g; this.cash -= g; }
  trade(qty: number, price: number, feeBps: number) {
    this.inv += qty; this.cash -= qty * price; this.fills++; this.volume += Math.abs(qty);
    const fee = (Math.abs(qty) * price * feeBps) / 10_000; this.feesUsd += fee; this.cash -= fee;
    this.maxInv = Math.max(this.maxInv, Math.abs(this.inv));
  }
  mark(mid: number) {
    const eq = this.cash + this.inv * mid;
    this.peak = Math.max(this.peak, eq); this.maxDd = Math.max(this.maxDd, this.peak - eq);
    return eq;
  }
}

const hoursOf = (books: BookRow[]) => (books.length > 1 ? (books.at(-1)!.ts - books[0]!.ts) / 3_600_000 : NaN);

function finish(strategy: string, params: Record<string, unknown>, books: BookRow[], a: Account, outcomes: number[]): Result {
  const hours = hoursOf(books);
  const pnl = a.mark(books.at(-1)!.mid);
  return {
    strategy, params, hours, pnlUsd: pnl, pnlPerHourUsd: pnl / hours, gasUsd: a.gasUsd, feesUsd: a.feesUsd, txs: a.txs,
    fills: a.fills, volumeMon: a.volume, winRate: outcomes.length ? outcomes.filter((x) => x > 0).length / outcomes.length : NaN,
    avgNetBps: mean(outcomes), maxDrawdownUsd: a.maxDd, maxInventoryMon: a.maxInv, endInventoryMon: a.inv,
  };
}

/** Latest forecast lean (pUp - pDown) at or before `block`, if no older than `maxAge` blocks. */
export function leanAt(preds: PredictionRow[], block: number, maxAge: number): number | null {
  const i = lowerBound(preds, block + 1, (p) => p.block) - 1;
  if (i < 0) return null;
  const p = preds[i]!;
  return block - p.block <= maxAge && !p.error ? p.pUp - p.pDown : null;
}

// ---------------------------------------------------------------------------------------------
// Strategy A: take the lag

export interface LagParams {
  /** Enter when fair value is this many bps beyond the touch (buy below fair, sell above). */
  thresholdBps: number;
  sizeMon: number;
  /** Exit after this many rows at the latest, or earlier once the remaining edge is below `exitBps`. */
  holdRows: number;
  exitBps: number;
  cooldownRows: number;
  basisRows: number;
  /** Optional Jev filter: skip entries the latest forecast leans against by more than this. */
  jev?: { preds: PredictionRow[]; maxAgeBlocks: number; minAgreement: number };
}
export const LAG_DEFAULTS: LagParams = { thresholdBps: 4, sizeMon: 1000, holdRows: 33, exitBps: 0.5, cooldownRows: 5, basisRows: 1000 };

/**
 * When the reference says Kuru is cheap (dear) by more than the threshold, buy the ask (sell the
 * bid) with a taker order that lands a block later at whatever the book then offers; close with
 * another taker order once Kuru has caught up or after `holdRows`. One position at a time.
 */
export function lagTaker(books: BookRow[], p: Partial<LagParams> = {}, costs: Costs = DEFAULT_COSTS, fair = fairValues(books, p.basisRows ?? LAG_DEFAULTS.basisRows)): Result {
  const o = { ...LAG_DEFAULTS, ...p };
  const a = new Account();
  const outcomes: number[] = [];
  let pos = 0, entryRow = -1, entryCash = 0, next = 0;
  for (let t = 0; t < books.length; t++) {
    const b = books[t]!, f = fair[t]!;
    a.mark(b.mid);
    if (pos === 0) {
      if (t < next || !Number.isFinite(f)) continue;
      const side = bps(f, b.ask) > o.thresholdBps ? 1 : bps(b.bid, f) > o.thresholdBps ? -1 : 0;
      if (!side) continue;
      if (o.jev) {
        const lean = leanAt(o.jev.preds, b.block, o.jev.maxAgeBlocks);
        if (lean !== null && side * lean < -o.jev.minAgreement) continue;
      }
      const j = landing(books, t, costs.latencyBlocks);
      if (j < 0) break;
      const land = books[j]!;
      const fill = walk(side > 0 ? land.asks : land.bids, o.sizeMon);
      const before = a.cash;
      a.tx(land.mid, costs);
      if (fill.qty <= 0) { next = t + o.cooldownRows; continue; } // the book emptied: gas spent for nothing
      a.trade(side * fill.qty, fill.price, costs.takerFeeBps);
      pos = side * fill.qty; entryRow = j; entryCash = before;
      t = j; // we are in from the landing row on
      continue;
    }
    const remaining = Number.isFinite(f) ? (pos > 0 ? bps(f, b.mid) : bps(b.mid, f)) : 0;
    if (t - entryRow < o.holdRows && remaining > o.exitBps) continue;
    const j = landing(books, t, costs.latencyBlocks);
    if (j < 0) break;
    const land = books[j]!;
    const fill = walk(pos > 0 ? land.bids : land.asks, Math.abs(pos));
    a.tx(land.mid, costs);
    if (fill.qty > 0) a.trade(-Math.sign(pos) * fill.qty, fill.price, costs.takerFeeBps);
    pos = a.inv;
    if (Math.abs(pos) < 1e-9) {
      pos = 0;
      const notional = Math.abs(fill.qty * fill.price);
      outcomes.push(((a.cash - entryCash) / notional) * 10_000);
      next = j + o.cooldownRows;
    }
    t = j;
  }
  const { jev, ...shown } = o;
  return finish("lag-taker", { ...shown, jev: jev ? { maxAgeBlocks: jev.maxAgeBlocks, minAgreement: jev.minAgreement } : false }, books, a, outcomes);
}

// ---------------------------------------------------------------------------------------------
// Strategy B: quote around the reference price

export interface MakerParams {
  /** Quote this many bps either side of fair value (never crossing the book: post-only). */
  halfSpreadBps: number;
  sizeMon: number;
  /** Re-quote (one tx for both sides) only when a wanted price moved this many bps from the live one. */
  requoteBps: number;
  maxInventoryMon: number;
  /** At full inventory, shift both quotes this many bps toward flattening. */
  skewBps: number;
  basisRows: number;
  /** false: fair value is Kuru's own mid (a baseline, to see what the reference adds). */
  useReference: boolean;
}
export const MAKER_DEFAULTS: MakerParams = { halfSpreadBps: 2, sizeMon: 1000, requoteBps: 2, maxInventoryMon: 5000, skewBps: 2, basisRows: 1000, useReference: true };

interface Resting { side: 1 | -1; price: number; left: number; ahead: number; liveAfter: number }

/** Size resting at exactly `price` on one side of a recorded book (0 if not among the recorded levels). */
function sizeAt(levels: [number, number][], price: number, tick: number) {
  for (const [p, s] of levels) if (Math.abs(p - price) < tick / 2) return s;
  return 0;
}

/**
 * Keep one post-only order on each side around fair value, skewed by inventory. A re-quote is one
 * batchUpdate (cancel both, place both) and costs one transaction. Fills come from the recorded
 * taker prints under price-time priority (see the header).
 */
export function refMaker(books: BookRow[], trades: TradeRow[], p: Partial<MakerParams> = {}, costs: Costs = DEFAULT_COSTS, fairIn?: number[]): Result {
  const o = { ...MAKER_DEFAULTS, ...p };
  const fair: number[] = o.useReference ? fairIn ?? fairValues(books, o.basisRows) : books.map((b) => b.mid);
  const a = new Account();
  const outcomes: number[] = [];
  const fillsAt: { row: number; side: 1 | -1; price: number }[] = [];
  let bid: Resting | null = null, ask: Resting | null = null;
  let pending: { row: number; bid: number | null; ask: number | null } | null = null;
  let ti = 0, row = 0;
  const tickDown = (x: number) => Math.floor(x / costs.tick + 1e-9) * costs.tick;
  const tickUp = (x: number) => Math.ceil(x / costs.tick - 1e-9) * costs.tick;

  const fillOrder = (r: Resting, qty: number) => {
    const q = Math.min(qty, r.left);
    if (q <= 0) return;
    a.trade(r.side * q, r.price, costs.makerFeeBps);
    r.left -= q;
    fillsAt.push({ row, side: r.side, price: r.price });
  };

  for (let t = 0; t < books.length; t++) {
    const b = books[t]!;
    row = t;

    // 1. taker prints since the last row, against orders already live
    while (ti < trades.length && trades[ti]!.block <= b.block) {
      const pr = trades[ti++]!;
      for (const r of [bid, ask]) {
        if (!r || r.left <= 0 || pr.block <= r.liveAfter) continue;
        const hits = r.side > 0 ? pr.side === "sell" : pr.side === "buy";
        if (!hits) continue;
        const through = r.side > 0 ? pr.price < r.price - costs.tick / 2 : pr.price > r.price + costs.tick / 2;
        const at = Math.abs(pr.price - r.price) < costs.tick / 2;
        if (through) fillOrder(r, pr.size);
        else if (at) { const eat = pr.size - r.ahead; r.ahead = Math.max(0, r.ahead - pr.size); if (eat > 0) fillOrder(r, eat); }
      }
    }

    // 2. the recorded book: shrink queues, and a book crossing our price means we were taken
    for (const r of [bid, ask]) {
      if (!r || r.left <= 0 || b.block <= r.liveAfter) continue;
      const crossed = r.side > 0 ? b.ask <= r.price + costs.tick / 2 : b.bid >= r.price - costs.tick / 2;
      if (crossed) { fillOrder(r, r.left); continue; }
      r.ahead = Math.min(r.ahead, sizeAt(r.side > 0 ? b.bids : b.asks, r.price, costs.tick));
    }
    if (bid && bid.left <= 1e-9) bid = null;
    if (ask && ask.left <= 1e-9) ask = null;

    // 3. a re-quote landing now replaces both orders (post-only: a price that would cross is rejected)
    if (pending && pending.row === t) {
      const mk = (side: 1 | -1, price: number | null): Resting | null => {
        if (price === null) return null;
        if (side > 0 ? price >= b.ask - costs.tick / 2 : price <= b.bid + costs.tick / 2) return null;
        const best = side > 0 ? b.bid : b.ask;
        const better = side > 0 ? price > best + costs.tick / 2 : price < best - costs.tick / 2;
        return { side, price, left: o.sizeMon, ahead: better ? 0 : sizeAt(side > 0 ? b.bids : b.asks, price, costs.tick), liveAfter: b.block };
      };
      bid = mk(1, pending.bid); ask = mk(-1, pending.ask);
      pending = null;
    }

    a.mark(b.mid);

    // 4. decide: where we want to be, and whether it is worth a transaction to get there
    if (pending) continue;
    const f: number = fair[t]!;
    let wantBid: number | null = null, wantAsk: number | null = null;
    if (Number.isFinite(f)) {
      const center: number = f * (1 - (o.skewBps * (a.inv / o.maxInventoryMon)) / 10_000);
      wantBid = a.inv + o.sizeMon <= o.maxInventoryMon ? Math.min(tickDown(center * (1 - o.halfSpreadBps / 10_000)), b.ask - costs.tick) : null;
      wantAsk = a.inv - o.sizeMon >= -o.maxInventoryMon ? Math.max(tickUp(center * (1 + o.halfSpreadBps / 10_000)), b.bid + costs.tick) : null;
    }
    const off = (r: Resting | null, want: number | null) =>
      want === null ? r !== null : r === null ? true : Math.abs(bps(want, r.price)) >= o.requoteBps;
    if (off(bid, wantBid) || off(ask, wantAsk)) {
      if (wantBid === null && wantAsk === null && !bid && !ask) continue; // nothing to cancel, nothing to place
      const j = landing(books, t, costs.latencyBlocks);
      if (j < 0) break;
      a.tx(books[j]!.mid, costs);
      pending = { row: j, bid: wantBid, ask: wantAsk };
    }
  }

  // each fill's result vs mid 33 rows after it, net of the gas spent per fill
  const gasPerFillBps = a.fills ? (a.gasUsd / a.fills / (o.sizeMon * books.at(-1)!.mid)) * 10_000 : 0;
  for (const m of fillsAt) {
    const k = Math.min(books.length - 1, m.row + 33);
    outcomes.push(m.side * bps(books[k]!.mid, m.price) - gasPerFillBps);
  }
  return finish(o.useReference ? "ref-maker" : "mid-maker", { ...o }, books, a, outcomes);
}

// ---------------------------------------------------------------------------------------------
// Honest tuning: pick parameters on the earlier part, report them on the later part

export interface Split { train: BookRow[]; test: BookRow[] }
export function splitByTime(books: BookRow[], testShare = 0.4): Split {
  const k = Math.floor(books.length * (1 - testShare));
  return { train: books.slice(0, k), test: books.slice(k) };
}

export function grid<T extends Record<string, unknown>>(axes: { [K in keyof T]: T[K][] }): T[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vs] of Object.entries(axes) as [string, unknown[]][]) out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out as T[];
}
