import { test, expect, describe } from "bun:test";
import { ADAPTERS, consensusMid, currentAsOf, QUIET_OK_MS } from "./ref";
import { parseVenues, DEFAULT_SYMBOLS } from "./config";
import { Store } from "./db";
import { TradeIndex, computeFeatures } from "./features";
import { coverage, evaluateForecasts, leadLag, makerMarkouts, outcome, takerArb } from "./analysis";
import { beta, corr, fitLogistic, quantile } from "./stats";
import { synth } from "./synth";

describe("reference venue parsers", () => {
  test("binance bookTicker", () => {
    expect(ADAPTERS.binance!.parse({ u: 1, s: "MONUSDT", b: "0.0226", B: "100", a: "0.0227", A: "50" }, null))
      .toEqual({ bid: 0.0226, ask: 0.0227, bidSize: 100, askSize: 50 });
    expect(ADAPTERS.binance!.parse({ result: null, id: 1 }, null)).toBeNull();
  });

  test("bybit orderbook.1 snapshot, one-sided delta, and junk", () => {
    const a = ADAPTERS.bybit!;
    const snap = a.parse({ topic: "orderbook.1.MONUSDT", type: "snapshot", data: { s: "MONUSDT", b: [["0.0226", "10"]], a: [["0.0227", "20"]] } }, null)!;
    expect(snap).toEqual({ bid: 0.0226, bidSize: 10, ask: 0.0227, askSize: 20 });
    expect(a.parse({ topic: "orderbook.1.MONUSDT", type: "delta", data: { b: [], a: [["0.02275", "5"]] } }, snap))
      .toEqual({ bid: 0.0226, bidSize: 10, ask: 0.02275, askSize: 5 });
    expect(a.parse({ op: "pong", success: true }, snap)).toBeNull();
  });

  test("okx bbo-tbt", () => {
    expect(ADAPTERS.okx!.parse({ arg: { channel: "bbo-tbt", instId: "MON-USDT" }, data: [{ asks: [["0.0227", "20", "0", "1"]], bids: [["0.0226", "10", "0", "2"]], ts: "1" }] }, null))
      .toEqual({ bid: 0.0226, bidSize: 10, ask: 0.0227, askSize: 20 });
    expect(ADAPTERS.okx!.parse({ event: "subscribe", arg: { channel: "bbo-tbt" } }, null)).toBeNull();
  });

  test("coinbase ticker", () => {
    expect(ADAPTERS.coinbase!.parse({ type: "ticker", best_bid: "0.0226", best_bid_size: "3", best_ask: "0.0227", best_ask_size: "4", price: "0.0226" }, null))
      .toEqual({ bid: 0.0226, bidSize: 3, ask: 0.0227, askSize: 4 });
    expect(ADAPTERS.coinbase!.parse({ type: "subscriptions" }, null)).toBeNull();
  });

  test("crossed or empty quotes are rejected", () => {
    expect(ADAPTERS.binance!.parse({ b: "0.03", B: "1", a: "0.02", A: "1" }, null)).toBeNull();
    expect(ADAPTERS.binance!.parse({ b: "0", B: "1", a: "0.02", A: "1" }, null)).toBeNull();
  });

  test("consensus mid is the median of fresh venues", () => {
    const now = 10_000;
    const q = (mid: number, ts: number) => ({ bid: mid - 0.001, ask: mid + 0.001, bidSize: 1, askSize: 1, ts });
    expect(consensusMid({ a: q(1, now), b: q(3, now), c: q(100, now - 5000) }, now)).toBe(2);
    expect(consensusMid({ a: q(1, now), b: q(3, now), c: q(2, now) }, now)).toBe(2);
    expect(consensusMid({ a: q(1, now - 9999) }, now)).toBeNull();
  });

  test("a quiet but live change-pushing feed keeps its quote current; trade-driven feeds do not", () => {
    const q = { bid: 1, ask: 2, bidSize: 1, askSize: 1, ts: 1_000 };
    const now = 100_000;
    expect(currentAsOf(q, { connected: true, lastMessageTs: now - 5_000 }, true, now)).toBe(now);
    expect(currentAsOf(q, { connected: true, lastMessageTs: now - QUIET_OK_MS - 1 }, true, now)).toBe(1_000);
    expect(currentAsOf(q, { connected: false, lastMessageTs: now }, true, now)).toBe(1_000);
    expect(currentAsOf(q, { connected: true, lastMessageTs: now }, false, now)).toBe(1_000);
    expect(ADAPTERS.coinbase!.pushesChanges).toBe(false);
    expect(ADAPTERS.bybit!.pushesChanges).toBe(true);
  });

  test("venue spec parsing", () => {
    expect(parseVenues("binance, okx:MON-USDC ,", DEFAULT_SYMBOLS)).toEqual([{ venue: "binance", symbol: "MONUSDT" }, { venue: "okx", symbol: "MON-USDC" }]);
  });
});

describe("store", () => {
  test("round-trips rows and dedupes on key", () => {
    const s = new Store(":memory:");
    const { books, trades, preds } = synth({ rows: 300 });
    books.forEach((b) => s.addBook(b));
    s.addBook(books[0]!); // duplicate block is ignored
    trades.forEach((t) => s.addTrade(t));
    preds.forEach((p) => s.addPrediction(p));
    s.addTick({ ts: 1, venue: "binance", bid: 1, ask: 2, bidSize: 3, askSize: 4 });
    s.setMeta("market", { takerFeeBps: 3 });
    expect(s.flush()).toBe(books.length + 1 + trades.length + preds.length + 1);
    expect(s.count("books")).toBe(books.length);
    expect(s.books()[5]).toEqual(books[5]!);
    expect(s.books({ fromTs: books[10]!.ts }).length).toBe(books.length - 10);
    expect(s.books({ lite: true })[5]!.depth).toEqual(books[5]!.depth);
    expect(s.books({ lite: true })[5]!.bids).toEqual(books[5]!.bids.slice(0, 1));
    expect(s.lastTs()).toBe(books.at(-1)!.ts);
    expect(s.trades()).toEqual(trades);
    expect(s.predictions({ model: "synthetic", withState: true })[0]).toEqual(preds[0]!);
    expect(s.predictions({ fromBlock: preds[1]!.block })[0]!.state).toBeNull();
    expect(s.meta()).toEqual({ market: { takerFeeBps: 3 } });
    s.close();
  });
});

describe("stats", () => {
  test("quantile, corr, beta", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(corr([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(beta([1, 2, 3, 4], [1, 3, 5, 7])).toBeCloseTo(2);
    expect(corr([1, NaN, 3, 4], [1, 5, 3, 4])).toBeCloseTo(1);
  });

  test("logistic regression learns a separable rule", () => {
    const X: number[][] = [], y: number[] = [];
    for (let i = 0; i < 200; i++) { const x = (i % 20) - 10 + 0.5; X.push([x, 1]); y.push(x > 0 ? 1 : 0); }
    const m = fitLogistic(X, y);
    expect(m.predict([5, 1])).toBeGreaterThan(0.9);
    expect(m.predict([-5, 1])).toBeLessThan(0.1);
  });
});

describe("features", () => {
  test("taker volume windows and returns", () => {
    const { books, trades } = synth({ rows: 300 });
    const idx = new TradeIndex(trades);
    const f = computeFeatures(books, 250, idx);
    const inWin = trades.filter((t) => t.block > books[230]!.block && t.block <= books[250]!.block);
    expect(f.flow.b20.buyMon).toBeCloseTo(inWin.filter((t) => t.side === "buy").reduce((s, t) => s + t.size, 0), 0);
    expect(f.retBps.b20).toBeCloseTo(((books[250]!.mid - books[230]!.mid) / books[230]!.mid) * 10_000, 1);
    expect(f.ref.venues).toBe(1);
    // with a constant basis the premium is steady; it carries the lag, so its change tracks the reference move
    expect(f.ref.premiumBps).not.toBeNull();
    expect(computeFeatures(books, 0, idx).retBps.b100).toBe(0);
  });
});

describe("analysis", () => {
  const { books, trades, preds } = synth({ rows: 6000, lag: 3 });

  test("coverage", () => {
    const c = coverage(books)!;
    expect(c.rows).toBe(6000);
    expect(c.gaps).toBe(0);
    expect(c.venueFresh.sim).toBe(1);
  });

  test("coverage of a market sampled every 2 blocks counts expected samples", () => {
    const sampled = books.slice(0, 100).map((b, i) => ({ ...b, block: b.block + i })).filter((_, i) => i !== 50);
    const c = coverage(sampled, 2)!;
    expect(c.blockCoverage).toBeCloseTo(99 / 100, 6);
    expect(c.gaps).toBe(1);
    expect(c.missingBlocks).toBe(2);
    expect(coverage(sampled)!.blockCoverage).toBeCloseTo(99 / 199, 6);
  });

  test("lead-lag finds the planted lag and full catch-up", () => {
    const ll = leadLag(books);
    expect(ll.best!.lag).toBe(3);
    expect(ll.best!.corr).toBeGreaterThan(0.9);
    const late = ll.catchUp.find((x) => x.afterBlocks === 10)!;
    expect(late.beta).toBeGreaterThan(0.9);
    expect(ll.catchUp.find((x) => x.afterBlocks === 1)!.beta).toBeLessThan(0.2);
    expect(ll.blocksPerRow).toBe(1);
    expect(ll.best!.lagBlocks).toBe(3);
  });

  test("maker markouts: capture is half the spread; uninformed flow means ~no adverse move", () => {
    const [m1] = makerMarkouts(books, trades, [1], 0);
    expect(m1!.captureBps).toBeCloseTo(3, 0); // half of 6 bps (mid moves a little between rows)
    const [m33] = makerMarkouts(books, trades, [33], 1);
    expect(Math.abs(m33!.adverseBps)).toBeLessThan(2);
    expect(m33!.netBps).toBeCloseTo(m33!.captureBps - m33!.adverseBps - 1, 6);
  });

  test("taker arb profits when Kuru lags, and not when it does not", () => {
    const lagged = takerArb(books, { thresholdsBps: [5], horizonBlocks: 10, takerFeeBps: 0, gasBps: 0 })[0]!;
    expect(lagged.trades).toBeGreaterThan(20);
    expect(lagged.netBps).toBeGreaterThan(0);
    const { books: sync } = synth({ rows: 6000, lag: 0 });
    const none = takerArb(sync, { thresholdsBps: [5], horizonBlocks: 10, takerFeeBps: 0, gasBps: 0 })[0]!;
    expect(none.trades).toBe(0);
  });

  test("taker arb pays gas and fees on both legs, and splits by day", async () => {
    const { takerArbByDay } = await import("./analysis");
    const free = takerArb(books, { thresholdsBps: [5], horizonBlocks: 10, takerFeeBps: 0, gasBps: 0 })[0]!;
    const costly = takerArb(books, { thresholdsBps: [5], horizonBlocks: 10, takerFeeBps: 0.5, gasBps: 1 })[0]!;
    expect(costly.trades).toBe(free.trades);
    expect(free.netBps - costly.netBps).toBeCloseTo(3, 9); // 2 x (0.5 + 1)
    const byDay = takerArbByDay(books, { thresholdsBps: [5], horizonBlocks: 10, takerFeeBps: 0, gasBps: 0 }, 100);
    expect(byDay.length).toBe(1);
    expect(byDay[0]!.results[0]!.trades).toBe(free.trades);
  });

  test("outcome labels", () => {
    const o = outcome(books, books[0]!.block, 100, 5)!;
    const r = ((books[100]!.mid - books[0]!.mid) / books[0]!.mid) * 10_000;
    expect(o.retBps).toBeCloseTo(r, 9);
    expect(o.label).toBe(r > 5 ? "up" : r < -5 ? "down" : "flat");
    expect(outcome(books, books.at(-1)!.block, 100, 5)).toBeNull();
  });

  test("the lead baseline finds a planted lag at a short horizon", () => {
    const s = synth({ rows: 6000, lag: 3, stepBps: 2, horizon: 10, flatBps: 2, skill: 0, seed: 5 });
    const r = evaluateForecasts(s.books, s.trades, s.preds) as any;
    expect(r.models.lead.accuracy).toBeGreaterThan(r.models.prior.accuracy);
    expect(r.models.lead.directional[0].meanSignedBps).toBeGreaterThan(0);
  });

  test("a skilled forecaster beats the baselines; a skill-less one does not", () => {
    const good = evaluateForecasts(books, trades, preds) as any;
    expect(good.models.jev.accuracy).toBeGreaterThan(good.models.prior.accuracy + 0.2);
    expect(good.models.jev.directional[0].meanSignedBps).toBeGreaterThan(0);
    const noise = synth({ rows: 6000, skill: 0, seed: 11 });
    const bad = evaluateForecasts(noise.books, noise.trades, noise.preds) as any;
    expect(bad.models.jev.accuracy).toBeLessThan(0.45);
    expect(bad.models.jev.logLoss).toBeGreaterThan(bad.models.prior.logLoss - 0.02);
  });
});

describe("jev forecaster", () => {
  test("sends the state and the up/down/flat question, and reads probabilities and confidence back", async () => {
    const { JevForecaster, jevState } = await import("./jev");
    const { books, trades } = synth({ rows: 300 });
    const index = new TradeIndex(trades);
    const state = jevState(computeFeatures(books, 250, index), books[250]!);
    let sent: any = null, url = "";
    const fakeFetch = (async (u: string, init: RequestInit) => {
      url = u; sent = JSON.parse(String(init.body));
      return Response.json({ model: "jev-latest", answers: { direction: { type: "choice", choice: "up", probabilities: { up: 0.55, down: 0.15, flat: 0.3 }, confidence: 0.8 } }, usage: { input_tokens: 612, output_tokens: 1 } });
    }) as unknown as typeof fetch;
    process.env.TYPESAFE_AI_API_KEY ||= "test-key";
    const f = await new JevForecaster({ fetch: fakeFetch, baseURL: "https://example.test/v1" }).forecast(state);
    expect(url).toBe("https://example.test/v1/systemone");
    expect(sent.questions.direction.type).toBe("choice");
    expect(Object.keys(sent.questions.direction.criteria)).toEqual(["up", "down", "flat"]);
    expect(sent.state.kuru.touchMon).toEqual([1000, 1000]);
    expect(sent.state.otherExchanges.returnsBps["1"]).toBeDefined();
    expect(sent.state.otherExchanges.notYetFollowedBps["5"]).toBeDefined();
    expect(sent.state.horizonBlocks).toBe(10);
    expect(sent.questions.direction.criteria.flat).toBe("within 2 bps");
    const { QUESTION } = await import("./jev");
    expect(new JevForecaster({ fetch: fakeFetch }).name.endsWith(`@v${QUESTION.version}`)).toBe(true);
    expect(f).toMatchObject({ pUp: 0.55, pDown: 0.15, pFlat: 0.3, choice: "up", confidence: 0.8, inputTokens: 612 });
    // tokens are the cost: keep the whole request small (v1 was ~2,400 chars, ~1,500 tokens)
    expect(JSON.stringify(sent).length).toBeLessThan(1000);
  });
});

describe("status page", () => {
  const base = {
    costs: { takerFeeBps: 3, makerFeeBps: 0, gasBpsPerTx: 1.8 },
    coverage: { hours: 30, blockCoverage: 0.97, venueFresh: { binance: 0.95 } },
    market: { spreadBps: { p50: 6 }, printsPerHour: 100, usdPerHour: 5000, distinctTakers: 4, distinctMakers: 3 },
    makerMarkouts: [{ horizon: 33, n: 500, netBps: 1.0 }],
    takerArb: [{ thresholdBps: 5, trades: 40, perHour: 2, netBps: 1.5, hitRate: 0.6 }],
    leadLag: { best: { lag: 3, lagBlocks: 3, corr: 0.4 }, catchUp: [{ afterBlocks: 10, blocks: 10, beta: 0.8 }] },
    forecasts: { models: { jev: { logLoss: 0.9, directional: [{ threshold: 0.2, n: 50, meanSignedBps: 20 }] }, prior: { logLoss: 1.0 }, logistic: { logLoss: 0.95 } } },
  };

  test("gates are judged from the report", async () => {
    const { gates } = await import("./status");
    const g = gates(base);
    expect(g.map((x) => x.state)).toEqual(["pass", "fail", "pass", "pass"]);
    expect(gates({ ...base, coverage: { ...base.coverage, hours: 3 } }).every((x) => x.state === "collecting")).toBe(true);
    const noJevEdge = gates({ ...base, forecasts: { models: { ...base.forecasts.models, jev: { logLoss: 1.2, directional: [{ threshold: 0.2, n: 5, meanSignedBps: 1 }] } } } });
    expect(noJevEdge[3]!.state).toBe("fail");
  });

  test("day-by-day table", async () => {
    const { renderDays } = await import("./status");
    expect(renderDays([])[0]).toContain("No finished days");
    const rows = renderDays([{ day: "2026-09-26", report: { ...base, takerArb: [{ thresholdBps: 20, trades: 21, netBps: 5.59 }], forecasts: { models: { jev: { logLoss: 1.13 }, lead: { logLoss: 0.84 } } } },
      backtest: { families: [{ name: "take the lag", all: [[{}, 0.1, -0.2, 3], [{}, 0.05, 0.03, 2]] }, { name: "quote around a fair price", all: [[{}, -1, -0.5, 9]] }] } }]);
    expect(rows[2]).toBe("| 2026-09-26 | 30.0 | 0.400 | 1.00 | 21, 5.59 | 0.030 | -0.500 | 1.130 vs 0.840 |");
  });

  test("renders with everything missing, and with a full report", async () => {
    const { renderStatus } = await import("./status");
    const empty = renderStatus({ report: null, health: null, deploy: null, now: new Date(0) });
    expect(empty).toContain("No health response");
    expect(empty).toContain("No report yet");
    const full = renderStatus({
      report: base, now: new Date(0),
      health: { ok: true, lastBlock: 5, lastBookAgeMs: 100, uptimeS: 7200, lastMid: 0.0226, lastSpreadBps: 6, stats: { recorded: 10, jevCalls: 1 }, venues: [{ venue: "okx", symbol: "MON-USDT", connected: true, lastQuoteAgeMs: null, lastError: null }] },
      deploy: { commit: "abcdef123", branch: "vps", deployedAt: "t", checkedAt: "t", result: "ok" },
    });
    expect(full).toContain("🟢 **Recording**");
    expect(full).toContain("| okx | MON-USDT | connected, no quotes | never |");
    expect(full).toContain("`abcdef1` from `vps`");
    expect(full).toContain("✅ pass");
    expect(full).toContain("No backtest yet.");
    const withBt = renderStatus({
      report: base, health: null, deploy: null, now: new Date(0),
      backtest: { hours: { train: 14.4, test: 9.6 }, costs: { latencyBlocks: 1, gasMon: 0.036 }, families: [{ name: "take the lag", variants: 48, variantsPositiveOnTest: 3, chosen: { variant: { thresholdBps: 5, sizeMon: 1000 }, train: { pnlPerHourUsd: 0.12 }, test: { pnlPerHourUsd: 0.05, txs: 40, fills: 40 } } }] },
    });
    expect(withBt).toContain("| take the lag | thresholdBps=5, sizeMon=1000 | 0.120 | **0.050** | 40 txs, 40 fills | 3 of 48 |");
  });

  test("cross-market tables and the markets recorder health", async () => {
    const { renderCompare, renderMarketsHealth, renderStatus } = await import("./status");
    expect(renderCompare([{ name: "X", report: null, backtest: null }])[0]).toContain("No market has enough data");
    const r = {
      ...base, costs: { ...base.costs, gasUsdPerTx: 0.001, gasBpsPerTx: 2 },
      market: { ...base.market, spreadBps: { p10: 1, p50: 2, p90: 4 }, usdPerHour: 324_000, printsPerHour: 1036, medianMid: 100, touchMon: { bid: 10, ask: 20 }, depthQuote: { "10": 167_000 } },
      leadLag: { best: { lagBlocks: 2, corr: 0.3 }, catchUp: [1, 3, 5, 10, 20].map((h) => ({ afterBlocks: h, blocks: h === 1 ? 2 : h, beta: h / 20 })) },
      takerArb: [{ thresholdBps: 10, trades: 60, perHour: 3, netBps: -1, hitRate: 0.4 }, { thresholdBps: 20, trades: 20, perHour: 1, grossBps: 9, netBps: 5, hitRate: 0.6 }],
      makerMarkouts: [{ horizon: 33, captureBps: 1, adverseBps: 1.5, netBps: -0.5 }],
    };
    const bt = { families: [
      { name: "take the lag", variants: 3, variantsPositiveOnTest: 1, chosen: { test: { pnlPerHourUsd: -0.01 } }, all: [[{ sizeUsd: 5 }, 0, 0.02, 1], [{ sizeUsd: 5 }, 0, -0.1, 1], [{ sizeUsd: 50 }, 0, -0.3, 1]] },
      { name: "quote around a fair price", variants: 2, variantsPositiveOnTest: 0, chosen: { test: { pnlPerHourUsd: -0.2 } }, all: [] },
    ] };
    const rows = renderCompare([{ name: "cbBTC/USDC", report: r, backtest: bt }]);
    expect(rows).toContain("| cbBTC/USDC | 324k | 1036 | 2.00 (1.00 / 4.00) | 3k | 167k | 95% | 2 (0.300) | 0.05@2 / 0.15 / 0.25 / 0.50 / 1.00 | 0.0010, 2.00 |");
    expect(rows).toContain("| cbBTC/USDC | 3.0 / 1.0 | 9.00 | -1.00 (40%) / 5.00 (60%) | 1.00 - 1.50 = -0.50 | 0.020 / -0.300 / n/a | -0.010 (1/3) / -0.200 (0/2) |");

    expect(renderMarketsHealth(null)[0]).toContain("no health response");
    const h = renderMarketsHealth({ ok: true, uptimeS: 3600, sampleEvery: 2, stats: { samples: 10, skipped: 0, requestErrors: 1, logErrors: 0 },
      markets: [{ pair: "WETH/USDC", rows: 9, prints: 4, readErrors: 0, lastBookAgeMs: 1500, lastSpreadBps: 1.9, venues: [{ venue: "okx", live: true }, { venue: "bybit", live: false }] }] });
    expect(h).toContain("| WETH/USDC | 9 | 4 | 0 | 1.5 s ago | 1.9 | okx |");
    const page = renderStatus({ report: base, health: null, deploy: null, now: new Date(0), markets: [{ name: "MON/USDC (control)", report: base, backtest: null }] });
    expect(page).toContain("## Cross-market comparison");
    expect(page).toContain("Markets recorder: no health response");
  });
});

describe("backtest", () => {
  const flat = (n: number, over: (i: number) => Partial<import("./db").BookRow> = () => ({})) =>
    Array.from({ length: n }, (_, i) => ({
      block: i, ts: i * 300, bid: 0.9999, ask: 1.0001, mid: 1, spreadBps: 2, imbalance: 0,
      bids: [[0.9999, 1000]] as [number, number][], asks: [[1.0001, 1000]] as [number, number][], depth: {}, ref: {}, readMs: 0, ...over(i),
    }));
  const print = (block: number, side: "buy" | "sell", size: number, price: number) =>
    ({ block, logIndex: 0, tx: `0x${block}${side}`, side, price, size, maker: "0xm", taker: "0xt", orderId: 1 });
  const costs = { latencyBlocks: 1, gasMon: 0, takerFeeBps: 0, makerFeeBps: 0, tick: 1e-5 };
  const maker = { sizeMon: 500, requoteBps: 100, maxInventoryMon: 1e9, skewBps: 0, useReference: false };

  test("walk takes levels best first", async () => {
    const { walk } = await import("./backtest");
    const w = walk([[1, 100], [1.1, 100]], 150);
    expect(w.qty).toBe(150);
    expect(w.price).toBeCloseTo((100 + 50 * 1.1) / 150, 12);
    expect(walk([[1, 100]], 150).qty).toBe(100);
  });

  test("maker joining the touch waits behind the queue", async () => {
    const { refMaker } = await import("./backtest");
    const r = refMaker(flat(10), [print(3, "sell", 600, 0.9999), print(4, "sell", 600, 0.9999)], { ...maker, halfSpreadBps: 1 }, costs);
    expect(r.fills).toBe(1);
    expect(r.endInventoryMon).toBeCloseTo(200, 6); // 1000 ahead: 600 + 400 eaten first, 200 left for us
    expect(r.txs).toBe(1);
  });

  test("maker improving the price is first in line; prints through the price fill it", async () => {
    const { refMaker } = await import("./backtest");
    const r = refMaker(flat(10), [print(3, "sell", 100, 0.9999)], { ...maker, halfSpreadBps: 0.5 }, costs);
    expect(r.endInventoryMon).toBeCloseTo(100, 6);
  });

  test("cancels ahead of us move us up the queue; prints before we are live do not count", async () => {
    const { refMaker } = await import("./backtest");
    const books = flat(10, (i) => (i >= 2 ? { bids: [[0.9999, 100]] as [number, number][] } : {}));
    const r = refMaker(books, [print(1, "sell", 5000, 0.9999), print(3, "sell", 150, 0.9999)], { ...maker, halfSpreadBps: 1 }, costs);
    expect(r.endInventoryMon).toBeCloseTo(50, 6);
  });

  test("gas uses the MON price when the market is not priced in MON", async () => {
    const { refMaker } = await import("./backtest");
    const btcLike = flat(10, () => ({ bid: 99_990, ask: 100_010, mid: 100_000, bids: [[99_990, 1]] as [number, number][], asks: [[100_010, 1]] as [number, number][] }));
    const r = refMaker(btcLike, [], { ...maker, sizeMon: 0.01, halfSpreadBps: 1 }, { ...costs, tick: 1, gasMon: 0.036, monUsd: 0.026 });
    expect(r.txs).toBe(1);
    expect(r.gasUsd).toBeCloseTo(0.036 * 0.026, 9);
  });

  test("gas is charged per transaction at the landing row's mid", async () => {
    const { refMaker } = await import("./backtest");
    const r = refMaker(flat(10), [], { ...maker, halfSpreadBps: 1 }, { ...costs, gasMon: 0.5 });
    expect(r.txs).toBe(1);
    expect(r.gasUsd).toBeCloseTo(0.5, 9);
    expect(r.pnlUsd).toBeCloseTo(-0.5, 9);
  });

  test("lag taker profits only when Kuru lags, and gas can eat it", async () => {
    const { lagTaker } = await import("./backtest");
    const lagged = synth({ rows: 6000, lag: 3, stepBps: 4, spreadBps: 2 }).books;
    const p = { thresholdBps: 3, sizeMon: 500, holdBlocks: 10, exitBps: 0.5 };
    const free = lagTaker(lagged, p, { ...costs, tick: 1e-6 });
    expect(free.txs).toBeGreaterThan(50);
    expect(free.pnlUsd).toBeGreaterThan(0);
    expect(free.avgNetBps).toBeGreaterThan(0);
    const pricey = lagTaker(lagged, p, { ...costs, tick: 1e-6, gasMon: 5 });
    expect(pricey.pnlUsd).toBeLessThan(0);
    const none = lagTaker(synth({ rows: 6000, lag: 0, stepBps: 4, spreadBps: 2 }).books, p, { ...costs, tick: 1e-6 });
    expect(none.txs).toBe(0);
  });

  test("jev filter skips entries the forecast leans against", async () => {
    const { lagTaker } = await import("./backtest");
    const { books } = synth({ rows: 6000, lag: 3, stepBps: 4, spreadBps: 2 });
    const bearish = books.map((b) => ({ block: b.block, ts: b.ts, model: "m", horizon: 100, flatBps: 5, pUp: 0, pDown: 1, pFlat: 0, choice: "down", confidence: null, latencyMs: 0, inputTokens: 0, state: null, error: null }));
    const p = { thresholdBps: 3, sizeMon: 500, holdBlocks: 10 };
    const all = lagTaker(books, p, { ...costs, tick: 1e-6 });
    const filtered = lagTaker(books, { ...p, jev: { preds: bearish, maxAgeBlocks: 60, minAgreement: 0.2 } }, { ...costs, tick: 1e-6 });
    expect(filtered.txs).toBeLessThan(all.txs); // no longs left
    expect(filtered.txs).toBeGreaterThan(0); // shorts still taken
  });

  test("grid and split", async () => {
    const { grid, splitByTime } = await import("./backtest");
    expect(grid({ a: [1, 2], b: ["x", "y", "z"] }).length).toBe(6);
    const s = splitByTime(flat(10), 0.4);
    expect([s.train.length, s.test.length]).toEqual([6, 4]);
  });
});

describe("trade logs", () => {
  test("decodeTradePrint reads a raw Trade log", async () => {
    const { decodeTradePrint } = await import("../trades");
    const w = (x: bigint | string) => (typeof x === "string" ? x.slice(2).padStart(64, "0") : x.toString(16).padStart(64, "0"));
    const maker = "0x" + "aa".repeat(20), taker = "0x" + "bb".repeat(20);
    const data = "0x" + [w(7n), w(maker), w(1n), w(95_000n * 10n ** 18n), w(0n), w(taker), w(taker), w(25n * 10n ** 6n)].join("");
    const p = decodeTradePrint({ address: "0x40c4", blockNumber: "0x10", logIndex: "0x2", transactionHash: "0xabc", data }, 8);
    expect(p).toEqual({ block: 16, price: 95_000, size: 0.25, side: "buy", tx: "0xabc", logIndex: 2, maker, taker, orderId: 7 });
    expect(decodeTradePrint({ blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x", data: "0x" + [w(1n), w(maker), w(0n), w(1n), w(0n), w(taker), w(taker), w(0n)].join("") }, 8)).toBeNull();
    expect(decodeTradePrint({ blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x", data: "0x00" }, 8)).toBeNull();
  });
});

describe("disk guard", () => {
  test("tiers by free space, and a failed read does nothing", async () => {
    const { diskTier } = await import("./guard");
    const gb = (x: number) => x * 1024 * 1024;
    expect([20, 9, 8.9, 6, 5.9, 3.5, 3.4, 2, 1.9, 0.1].map((x) => diskTier(gb(x)))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(diskTier(NaN)).toBe(0);
  });

  test("a store waits for another writer instead of crashing, and keeps rows if a flush fails", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/lock-`)}/m.sqlite`;
    const s = new Store(path);
    const { books } = synth({ rows: 5 });
    // another process holds the write lock for ~700 ms (as the disk guard does while trimming)
    const holder = Bun.spawn([process.execPath, "-e", `const {Database}=require("bun:sqlite");const d=new Database(${JSON.stringify(path)});d.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");console.log("locked");await Bun.sleep(700);d.exec("COMMIT")`], { stdout: "pipe" });
    await holder.stdout.getReader().read();
    books.forEach((b) => s.addBook(b));
    expect(s.flush()).toBe(5); // waited for the lock
    await holder.exited;
    expect(s.count("books")).toBe(5);

    // a flush that fails puts its rows back
    const db = (s as any).db;
    const real = db.transaction.bind(db);
    db.transaction = () => () => { throw new Error("boom"); };
    synth({ rows: 8 }).books.slice(5).forEach((b) => s.addBook(b));
    expect(() => s.flush()).toThrow("boom");
    db.transaction = real;
    expect(s.flush()).toBe(3);
    expect(s.count("books")).toBe(8);
    s.close();
  });

  test("pruning ticks keeps recent ticks and everything else", async () => {
    const { pruneTicks } = await import("./guard");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/guard-`)}/m.sqlite`;
    const s = new Store(path);
    const now = 1_800_000_000_000, hour = 3_600_000;
    const { books } = synth({ rows: 50 });
    books.forEach((b) => s.addBook(b));
    for (let i = 0; i < 45_000; i++) s.addTick({ ts: now - 30 * hour + i, venue: "okx", bid: 1, ask: 2, bidSize: 1, askSize: 1 }); // old, > 2 batches
    for (let i = 0; i < 100; i++) s.addTick({ ts: now - hour + i, venue: "okx", bid: 1, ask: 2, bidSize: 1, askSize: 1 });
    s.flush();
    expect(s.count("ref_ticks")).toBe(45_100);
    expect(pruneTicks(path, 24, now)).toBe(45_000);
    expect(s.count("ref_ticks")).toBe(100);
    expect(s.count("books")).toBe(books.length);
    expect(pruneTicks(path, 24, now)).toBe(0);
    expect(pruneTicks(`${path}.missing`, 24, now)).toBe(0);
    s.close();
  });
});

describe("market survey", () => {
  const word = (x: bigint) => x.toString(16).padStart(64, "0");
  const log = (address: string, isBuy: number, price: number, size: number, taker: number) => ({
    address, blockNumber: "0x1",
    data: "0x" + word(1n) + word(0xaan) + word(BigInt(isBuy)) + word(BigInt(Math.round(price * 1e6)) * 10n ** 12n) + word(0n) + word(BigInt(taker)) + word(BigInt(taker)) + word(BigInt(size) * 10n ** 10n),
  });

  test("aggregates trades per market and skips unknown markets", async () => {
    const { summarizeTrades } = await import("./survey");
    const out = summarizeTrades([log("0xA", 1, 2, 100, 1), log("0xa", 0, 2, 300, 2), log("0xb", 1, 5, 10, 1), log("0xc", 1, 1, 1, 1)], (a) => (a === "0xc" ? null : 10));
    const a = out.find((m) => m.address === "0xa")!;
    expect(a).toMatchObject({ trades: 2, baseVolume: 400, quoteVolume: 800, takers: 2, makers: 1, medianTradeBase: 200 });
    expect(out.find((m) => m.address === "0xb")!.quoteVolume).toBe(50);
    expect(out.some((m) => m.address === "0xc")).toBe(false);
  });

  test("reference asset per pair", async () => {
    const { referenceFor } = await import("./survey");
    expect(referenceFor("cbBTC", "USDC")).toBe("BTC");
    expect(referenceFor("WETH", "USDC")).toBe("ETH");
    expect(referenceFor("MON", "AUSD")).toBe("MON");
    expect(referenceFor("XAUt0", "USDC")).toBe("XAUT");
    expect(referenceFor("AUSD", "USDC")).toBeNull();
    expect(referenceFor("emo", "MON")).toBeNull();
  });
});
