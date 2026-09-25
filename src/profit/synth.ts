/**
 * Synthetic recordings with known structure, for tests and for trying the analyzer without a live
 * feed: the reference price is a random walk, Kuru copies it `lag` rows late (plus a fixed basis),
 * takers trade at the touch, and an optional forecaster sees the future with some noise.
 */
import type { BookRow, PredictionRow, TradeRow } from "./db";

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

export interface SynthOpts {
  rows: number; lag: number; stepBps: number; spreadBps: number; basisBps: number; tradeProb: number;
  /** 0 = forecasts are noise, 1 = forecasts know the sign of the future move. */
  skill: number; predictEvery: number; horizon: number; flatBps: number; seed: number;
}
export const SYNTH_DEFAULTS: SynthOpts = { rows: 6000, lag: 3, stepBps: 2, spreadBps: 6, basisBps: 4, tradeProb: 0.2, skill: 0.7, predictEvery: 10, horizon: 100, flatBps: 5, seed: 7 };

export function synth(o: Partial<SynthOpts> = {}) {
  const opt = { ...SYNTH_DEFAULTS, ...o }, r = rng(opt.seed);
  const ref: number[] = [0.025];
  for (let i = 1; i < opt.rows + opt.lag; i++) ref.push(ref[i - 1]! * (1 + (gauss(r) * opt.stepBps) / 10_000));
  const books: BookRow[] = [], trades: TradeRow[] = [], preds: PredictionRow[] = [];
  const t0 = 1_800_000_000_000, block0 = 100_000_000;
  for (let i = 0; i < opt.rows; i++) {
    const refMid = ref[i + opt.lag]!;
    const mid = ref[i]! / (1 + opt.basisBps / 10_000);
    const half = (mid * opt.spreadBps) / 20_000;
    const ts = t0 + i * 300, block = block0 + i;
    books.push({
      block, ts, bid: mid - half, ask: mid + half, mid, spreadBps: opt.spreadBps, imbalance: 0,
      bids: [[mid - half, 1000]], asks: [[mid + half, 1000]], depth: { "10": { bid: 1000, ask: 1000 } },
      ref: { sim: { bid: refMid * (1 - 1e-4), ask: refMid * (1 + 1e-4), bidSize: 1, askSize: 1, ts: ts - 50 } }, readMs: 20,
    });
    if (r() < opt.tradeProb) {
      const side = r() < 0.5 ? "buy" : "sell";
      trades.push({ block, logIndex: 0, tx: `0x${i.toString(16)}`, side, price: side === "buy" ? mid + half : mid - half, size: 200 + Math.floor(r() * 800), maker: "0xm", taker: "0xt", orderId: i });
    }
  }
  for (let i = 0; i + opt.horizon < opt.rows; i += opt.predictEvery) {
    const fwd = ((books[i + opt.horizon]!.mid - books[i]!.mid) / books[i]!.mid) * 10_000;
    const knows = r() < opt.skill;
    const guess = knows ? (fwd > opt.flatBps ? "up" : fwd < -opt.flatBps ? "down" : "flat") : (["up", "down", "flat"] as const)[Math.floor(r() * 3)]!;
    const p = { up: 0.2, down: 0.2, flat: 0.2, [guess]: 0.6 };
    preds.push({ block: books[i]!.block, ts: books[i]!.ts, model: "synthetic", horizon: opt.horizon, flatBps: opt.flatBps, pUp: p.up, pDown: p.down, pFlat: p.flat, choice: guess, confidence: null, latencyMs: 90, inputTokens: 500, state: {}, error: null });
  }
  return { books, trades, preds, opts: opt };
}
