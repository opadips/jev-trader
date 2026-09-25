/**
 * The questions Phase 1 has to answer, each as a pure function over recorded rows:
 *
 *   1. Is there flow?                     marketStats
 *   2. Does resting on Kuru's book pay?   makerMarkouts   (spread earned vs the move after the fill)
 *   3. Does Kuru lag other exchanges?     leadLag
 *   4. Can we trade that lag as a taker?  takerArb
 *   5. Does Jev know where price goes?    evaluateForecasts (against simple baselines on the same blocks)
 *
 * Returns are in bps. "Rows" are recorded book reads (~1 per 300 ms block).
 */
import type { BookRow, PredictionRow, TradeRow } from "./db";
import { TradeIndex, computeFeatures, refMids, vector } from "./features";
import { beta, corr, fitLogistic, lowerBound, mean, quantile, std, weightedMean } from "./stats";

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;
const byBlock = (b: BookRow) => b.block;

/** Index of the last book row strictly before `block` (the state a trade in `block` met), or -1. */
const rowBefore = (books: BookRow[], block: number) => lowerBound(books, block, byBlock) - 1;
/** Index of the first book row at or after `block`, or -1 if the recording ends first. */
function rowAtOrAfter(books: BookRow[], block: number) {
  const i = lowerBound(books, block, byBlock);
  return i < books.length ? i : -1;
}

// ---------------------------------------------------------------------------------------------

export function coverage(books: BookRow[]) {
  if (!books.length) return null;
  const first = books[0]!, last = books.at(-1)!;
  const hours = (last.ts - first.ts) / 3_600_000;
  let gaps = 0, missing = 0;
  for (let i = 1; i < books.length; i++) {
    const d = books[i]!.block - books[i - 1]!.block;
    if (d > 1) { gaps++; missing += d - 1; }
  }
  const venues = new Map<string, number>();
  for (const b of books) for (const [v, q] of Object.entries(b.ref)) if (b.ts - q.ts <= 2000) venues.set(v, (venues.get(v) ?? 0) + 1);
  return {
    rows: books.length, fromBlock: first.block, toBlock: last.block, hours,
    blockCoverage: books.length / (last.block - first.block + 1), gaps, missingBlocks: missing,
    venueFresh: Object.fromEntries([...venues].map(([v, n]) => [v, n / books.length])),
  };
}

export function marketStats(books: BookRow[], trades: TradeRow[]) {
  const hours = books.length > 1 ? (books.at(-1)!.ts - books[0]!.ts) / 3_600_000 : NaN;
  const spreads = books.map((b) => b.spreadBps);
  const r100: number[] = [];
  for (let i = 100; i < books.length; i += 100) r100.push(bps(books[i]!.mid, books[i - 100]!.mid));
  const sizes = trades.map((t) => t.size);
  const vol = sizes.reduce((s, x) => s + x, 0);
  const notional = trades.reduce((s, t) => s + t.size * t.price, 0);
  return {
    spreadBps: { p10: quantile(spreads, 0.1), p50: quantile(spreads, 0.5), p90: quantile(spreads, 0.9) },
    touchMon: { bid: quantile(books.map((b) => b.bids[0]?.[1] ?? 0), 0.5), ask: quantile(books.map((b) => b.asks[0]?.[1] ?? 0), 0.5) },
    move100BlocksBps: std(r100),
    printsPerHour: trades.length / hours,
    monPerHour: vol / hours,
    usdPerHour: notional / hours,
    medianPrintMon: quantile(sizes, 0.5),
    takerBuyShare: vol ? trades.filter((t) => t.side === "buy").reduce((s, t) => s + t.size, 0) / vol : NaN,
    distinctTakers: new Set(trades.map((t) => t.taker)).size,
    distinctMakers: new Set(trades.map((t) => t.maker)).size,
  };
}

/**
 * What the maker on the other side of every print earned, `h` rows later, per unit, in bps of the
 * pre-trade mid, after the maker fee:
 *   capture = how far from mid the maker got filled (half the spread at the touch)
 *   adverse = how far mid then moved against the maker
 *   net     = capture - adverse - makerFee
 * If `net` at 10 to 30 s is not comfortably above the gas a quote costs, passive market making on
 * this book does not pay, whatever the model.
 */
export function makerMarkouts(books: BookRow[], trades: TradeRow[], horizons: number[], makerFeeBps: number) {
  return horizons.map((h) => {
    const cap: number[] = [], adv: number[] = [], net: number[] = [], w: number[] = [];
    for (const t of trades) {
      const i = rowBefore(books, t.block);
      const j = rowAtOrAfter(books, t.block + h);
      if (i < 0 || j < 0) continue;
      const m0 = books[i]!.mid, m1 = books[j]!.mid;
      const dir = t.side === "buy" ? 1 : -1; // taker buy: the maker sold, loses if mid rises
      const c = dir * bps(t.price, m0), a = dir * bps(m1, m0);
      cap.push(c); adv.push(a); net.push(c - a - makerFeeBps); w.push(t.size);
    }
    return { horizon: h, n: net.length, captureBps: weightedMean(cap, w), adverseBps: weightedMean(adv, w), netBps: weightedMean(net, w), netMedianBps: quantile(net, 0.5) };
  });
}

/**
 * Does Kuru follow the other exchanges? `corr[lag]` correlates the reference return at row t with
 * the Kuru return at row t + lag (positive lag = reference leads). `catchUp[k]` is the share of a
 * reference move that Kuru has absorbed k rows later (OLS beta of Kuru's k-row forward return on
 * the reference's 1-row return).
 */
export function leadLag(books: BookRow[], maxLag = 30, catchUpRows = [1, 3, 10, 30, 100]) {
  const refs = refMids(books);
  const n = books.length;
  const kr = books.map((b, i) => (i ? bps(b.mid, books[i - 1]!.mid) : NaN));
  const rr = refs.map((r, i) => (i && r !== null && refs[i - 1] != null ? bps(r, refs[i - 1]!) : NaN));
  const usable = rr.filter(Number.isFinite).length;
  const corrByLag: { lag: number; corr: number }[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a: number[] = [], b: number[] = [];
    for (let t = 0; t < n; t++) { const u = t + lag; if (u < 0 || u >= n) continue; a.push(rr[t]!); b.push(kr[u]!); }
    corrByLag.push({ lag, corr: corr(a, b) });
  }
  const catchUp = catchUpRows.map((k) => {
    const x: number[] = [], y: number[] = [];
    for (let t = 1; t + k < n; t++) { x.push(rr[t]!); y.push(bps(books[t + k]!.mid, books[t]!.mid)); }
    return { rows: k, beta: beta(x, y) };
  });
  const best = corrByLag.filter((c) => Number.isFinite(c.corr)).sort((a, b) => b.corr - a.corr)[0] ?? null;
  return { usableRows: usable, best, corrByLag, catchUp };
}

/**
 * Taker arbitrage against the reference. At each row, the reference says fair value is
 * refMid adjusted by the typical premium (a trailing mean, so a steady USD/USDT/USDC basis is
 * not mistaken for edge). If buying Kuru's ask is cheaper than that fair value by more than
 * `thresholdBps`, we buy; symmetric for selling the bid. We see the book at row t and the order
 * lands a row later, so the fill price is the ask (bid) at row t+1. Result per trade, after the
 * taker fee and gas: mid `h` rows after entry minus the price paid. One trade per `cooldown` rows.
 */
export function takerArb(
  books: BookRow[],
  opts: { thresholdsBps: number[]; horizon: number; takerFeeBps: number; gasBps: number; basisRows?: number; cooldown?: number },
) {
  const { thresholdsBps, horizon, takerFeeBps, gasBps, basisRows = 1000, cooldown = 10 } = opts;
  const refs = refMids(books);
  const prem = refs.map((r, i) => (r === null ? NaN : bps(r, books[i]!.mid)));
  // trailing mean premium over up to `basisRows` previous rows with reference data
  const basis: number[] = [];
  let sum = 0, cnt = 0;
  const win: number[] = [];
  for (let i = 0; i < books.length; i++) {
    basis.push(cnt >= 50 ? sum / cnt : NaN);
    if (Number.isFinite(prem[i]!)) { win.push(prem[i]!); sum += prem[i]!; cnt++; }
    else win.push(NaN);
    if (win.length > basisRows) { const old = win.shift()!; if (Number.isFinite(old)) { sum -= old; cnt--; } }
  }
  const hours = books.length > 1 ? (books.at(-1)!.ts - books[0]!.ts) / 3_600_000 : NaN;
  return thresholdsBps.map((th) => {
    const pnl: number[] = [];
    let next = 0;
    for (let t = 0; t + 1 + horizon < books.length; t++) {
      if (t < next || !Number.isFinite(prem[t]!) || !Number.isFinite(basis[t]!)) continue;
      const fair = books[t]!.mid * (1 + (prem[t]! - basis[t]!) / 10_000);
      const b = books[t]!, fill = books[t + 1]!, exit = books[t + 1 + horizon]!.mid;
      let r: number | null = null;
      if (bps(fair, b.ask) > th) r = bps(exit, fill.ask);
      else if (bps(b.bid, fair) > th) r = bps(fill.bid, exit);
      if (r === null) continue;
      pnl.push(r - takerFeeBps - gasBps);
      next = t + cooldown;
    }
    return { thresholdBps: th, trades: pnl.length, perHour: pnl.length / hours, netBps: mean(pnl), hitRate: pnl.length ? pnl.filter((x) => x > 0).length / pnl.length : NaN };
  });
}

// ---------------------------------------------------------------------------------------------
// Forecasts

type Label = "up" | "down" | "flat";

/** Realised outcome of a forecast made at `block`: forward return over `horizon` blocks and its class. */
export function outcome(books: BookRow[], block: number, horizon: number, flatBps: number): { retBps: number; label: Label } | null {
  const i = lowerBound(books, block, byBlock);
  if (i >= books.length || books[i]!.block !== block) return null;
  const j = rowAtOrAfter(books, block + horizon);
  if (j < 0) return null;
  const r = bps(books[j]!.mid, books[i]!.mid);
  return { retBps: r, label: r > flatBps ? "up" : r < -flatBps ? "down" : "flat" };
}

/** Score a set of (pUp, pDown, pFlat) forecasts against outcomes. `score` = pUp - pDown drives the directional test. */
export function scoreForecasts(items: { pUp: number; pDown: number; pFlat: number; retBps: number; label: Label }[], thresholds = [0, 0.1, 0.2, 0.3, 0.5]) {
  const eps = 1e-6;
  let ll = 0, brier = 0, hits = 0;
  for (const f of items) {
    const p = { up: f.pUp, down: f.pDown, flat: f.pFlat };
    const tot = p.up + p.down + p.flat || 1;
    ll -= Math.log(Math.max(eps, p[f.label] / tot));
    for (const k of ["up", "down", "flat"] as const) brier += (p[k] / tot - (f.label === k ? 1 : 0)) ** 2;
    const choice = (Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]) as Label;
    if (choice === f.label) hits++;
  }
  const n = items.length;
  const directional = thresholds.map((th) => {
    const r: number[] = [];
    for (const f of items) { const s = f.pUp - f.pDown; if (s > th) r.push(f.retBps); else if (s < -th) r.push(-f.retBps); }
    return { threshold: th, n: r.length, meanSignedBps: mean(r), hitRate: r.length ? r.filter((x) => x > 0).length / r.length : NaN };
  });
  return { n, accuracy: hits / n, logLoss: ll / n, brier: brier / n, directional };
}

/**
 * Jev against three baselines on the same held-out blocks (the last `testShare` of the forecasts):
 *   prior     class frequencies from the training period (knows nothing about the market state)
 *   momentum  up if the last 20 rows went up, down if they went down
 *   logistic  up-vs-down logistic regression on the same features Jev sees, trained on the
 *             training period's rows
 * Jev earns its place only if it beats all three out of sample.
 */
export function evaluateForecasts(books: BookRow[], trades: TradeRow[], preds: PredictionRow[], opts: { testShare?: number; sampleEvery?: number } = {}) {
  const { testShare = 0.4, sampleEvery = 5 } = opts;
  const ok = preds.filter((p) => !p.error);
  if (!ok.length) return null;
  const horizon = ok[0]!.horizon, flatBps = ok[0]!.flatBps;
  const labelled = ok.map((p) => ({ p, o: outcome(books, p.block, horizon, flatBps) })).filter((x) => x.o) as { p: PredictionRow; o: NonNullable<ReturnType<typeof outcome>> }[];
  if (labelled.length < 20) return { horizon, flatBps, n: labelled.length, note: "not enough labelled forecasts yet" };
  const split = labelled[Math.floor(labelled.length * (1 - testShare))]!.p.block;
  const test = labelled.filter((x) => x.p.block >= split);

  // training data for the baselines: every `sampleEvery`-th row before the split whose outcome is known before the split too
  const index = new TradeIndex(trades);
  const refs = refMids(books);
  const trainX: number[][] = [], trainY: number[] = [];
  const counts = { up: 0, down: 0, flat: 0 };
  for (let i = 0; i < books.length; i += sampleEvery) {
    const b = books[i]!;
    if (b.block + horizon >= split) break;
    const o = outcome(books, b.block, horizon, flatBps);
    if (!o) continue;
    counts[o.label]++;
    if (o.label === "flat") continue;
    trainX.push(vector(computeFeatures(books, i, index, refs)));
    trainY.push(o.label === "up" ? 1 : 0);
  }
  const total = counts.up + counts.down + counts.flat || 1;
  const prior = { pUp: counts.up / total, pDown: counts.down / total, pFlat: counts.flat / total };
  const logit = trainX.length >= 30 && new Set(trainY).size === 2 ? fitLogistic(trainX, trainY) : null;

  const rowsOf = test.map((x) => lowerBound(books, x.p.block, byBlock));
  const jev = test.map((x) => ({ pUp: x.p.pUp, pDown: x.p.pDown, pFlat: x.p.pFlat, ...x.o }));
  const priorF = test.map((x) => ({ ...prior, ...x.o }));
  const momentum = test.map((x, k) => {
    const i = rowsOf[k]!, r = i >= 20 ? bps(books[i]!.mid, books[i - 20]!.mid) : 0;
    return { pUp: r > 0 ? 0.6 : 0.2, pDown: r < 0 ? 0.6 : 0.2, pFlat: r === 0 ? 0.6 : 0.2, ...x.o };
  });
  const logistic = logit && test.map((x, k) => {
    const pu = logit.predict(vector(computeFeatures(books, rowsOf[k]!, index, refs)));
    const moving = 1 - prior.pFlat;
    return { pUp: pu * moving, pDown: (1 - pu) * moving, pFlat: prior.pFlat, ...x.o };
  });

  return {
    horizon, flatBps, n: labelled.length, testN: test.length, splitBlock: split, trainRows: trainX.length,
    testClassShare: { up: test.filter((x) => x.o.label === "up").length / test.length, down: test.filter((x) => x.o.label === "down").length / test.length, flat: test.filter((x) => x.o.label === "flat").length / test.length },
    models: { jev: scoreForecasts(jev), prior: scoreForecasts(priorF), momentum: scoreForecasts(momentum), ...(logistic ? { logistic: scoreForecasts(logistic) } : {}) },
    jevLatencyMs: { p50: quantile(ok.map((p) => p.latencyMs), 0.5), p95: quantile(ok.map((p) => p.latencyMs), 0.95) },
    jevErrorRate: 1 - ok.length / preds.length,
  };
}
