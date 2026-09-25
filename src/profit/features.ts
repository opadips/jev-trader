/**
 * Market features at one recorded block. One implementation serves both the live Jev input and the
 * analyzer's baselines, so "Jev vs a simple model" compares like with like.
 *
 * Lookbacks count recorded rows, not chain blocks: the recorder skips a block now and then when
 * heads arrive in a burst, so "20 back" is ~20 blocks.
 */
import type { BookRow, TradeRow } from "./db";
import { consensusMid } from "./ref";

/** Taker volume in a block window via prefix sums: O(log n) per query. Trades must be sorted by block. */
export class TradeIndex {
  private blocks: number[] = [];
  private buy: number[] = [0];
  private sell: number[] = [0];
  constructor(readonly trades: TradeRow[]) {
    for (const t of trades) {
      this.blocks.push(t.block);
      this.buy.push(this.buy.at(-1)! + (t.side === "buy" ? t.size : 0));
      this.sell.push(this.sell.at(-1)! + (t.side === "sell" ? t.size : 0));
    }
  }
  /** Index of the first trade with block > b. */
  private after(b: number) {
    let lo = 0, hi = this.blocks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.blocks[m]! <= b) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Taker buy and sell MON over blocks (from, to]. */
  volume(from: number, to: number) {
    const i = this.after(from), j = this.after(to);
    return { buyMon: this.buy[j]! - this.buy[i]!, sellMon: this.sell[j]! - this.sell[i]!, count: j - i };
  }
  /** Up to n trades with block <= b, newest last. */
  recent(b: number, n: number) {
    const j = this.after(b);
    return this.trades.slice(Math.max(0, j - n), j);
  }
}

export interface Features {
  block: number;
  mid: number;
  spreadBps: number;
  imbalance: number;
  /** Kuru mid return over the last N recorded blocks, bps. */
  retBps: { b1: number; b5: number; b20: number; b100: number };
  /** Std dev of 5-block returns over the last 100 blocks, bps. */
  volBps: number;
  /** Taker flow. cvdNorm = (buy - sell) / (buy + sell), 0 when no prints. */
  flow: { b20: { buyMon: number; sellMon: number; cvdNorm: number }; b100: { buyMon: number; sellMon: number; cvdNorm: number } };
  depth: Record<string, { bid: number; ask: number }>;
  /**
   * Other exchanges. premiumBps = (consensus mid elsewhere - Kuru mid) / Kuru mid. Positive means
   * MON is dearer elsewhere. It carries a steady USD/USDT/USDC basis, so the change matters more.
   */
  ref: { venues: number; premiumBps: number | null; premiumChg20Bps: number | null; refRetBps: { b5: number | null; b20: number | null } };
}

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;
const cvd = (v: { buyMon: number; sellMon: number }) => ({ buyMon: round(v.buyMon, 1), sellMon: round(v.sellMon, 1), cvdNorm: v.buyMon + v.sellMon ? round((v.buyMon - v.sellMon) / (v.buyMon + v.sellMon), 3) : 0 });
export const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Consensus reference mid for each row, computed once per row array. */
export function refMids(books: BookRow[]): (number | null)[] {
  return books.map((b) => consensusMid(b.ref, b.ts));
}

/** Features at books[i], using only rows <= i and trades with block <= books[i].block. */
export function computeFeatures(books: BookRow[], i: number, trades: TradeIndex, refs: (number | null)[] = refMids(books)): Features {
  const b = books[i]!;
  const back = (k: number) => books[Math.max(0, i - k)]!;
  const ret = (k: number) => (i >= k ? round(bps(b.mid, back(k).mid), 2) : 0);

  const r5: number[] = [];
  for (let j = i; j - 5 >= Math.max(0, i - 100); j -= 5) r5.push(bps(books[j]!.mid, books[j - 5]!.mid));
  const mean = r5.reduce((s, x) => s + x, 0) / (r5.length || 1);
  const volBps = r5.length > 1 ? Math.sqrt(r5.reduce((s, x) => s + (x - mean) ** 2, 0) / (r5.length - 1)) : 0;

  const ref = refs[i] ?? null;
  const refBack = (k: number) => (i >= k ? refs[i - k] ?? null : null);
  const prem = (r: number | null, row: BookRow) => (r === null ? null : bps(r, row.mid));
  const premNow = prem(ref, b), prem20 = prem(refBack(20), back(20));
  const refRet = (k: number) => { const r0 = refBack(k); return ref !== null && r0 !== null ? round(bps(ref, r0), 2) : null; };

  return {
    block: b.block,
    mid: b.mid,
    spreadBps: round(b.spreadBps, 2),
    imbalance: round(b.imbalance, 3),
    retBps: { b1: ret(1), b5: ret(5), b20: ret(20), b100: ret(100) },
    volBps: round(volBps, 2),
    flow: { b20: cvd(trades.volume(back(20).block, b.block)), b100: cvd(trades.volume(back(100).block, b.block)) },
    depth: b.depth,
    ref: {
      venues: Object.values(b.ref).filter((q) => b.ts - q.ts <= 2000).length,
      premiumBps: premNow === null ? null : round(premNow, 2),
      premiumChg20Bps: premNow !== null && prem20 !== null ? round(premNow - prem20, 2) : null,
      refRetBps: { b5: refRet(5), b20: refRet(20) },
    },
  };
}

/** Fixed-order numeric vector for the logistic baseline. Missing reference data becomes 0. */
export const FEATURE_NAMES = ["ret1", "ret5", "ret20", "ret100", "imbalance", "cvd20", "cvd100", "spread", "vol", "premChg20", "refRet5", "refRet20"] as const;
export function vector(f: Features): number[] {
  return [
    f.retBps.b1, f.retBps.b5, f.retBps.b20, f.retBps.b100, f.imbalance, f.flow.b20.cvdNorm, f.flow.b100.cvdNorm,
    f.spreadBps, f.volBps, f.ref.premiumChg20Bps ?? 0, f.ref.refRetBps.b5 ?? 0, f.ref.refRetBps.b20 ?? 0,
  ];
}
