/**
 * Profit Mode, phase 0: record the market, sign nothing.
 *
 * Every block: one Kuru book read (with the other exchanges' latest quotes attached), Trade logs
 * since the last poll, and every `JEV_EVERY` blocks one Jev up/down/flat forecast. Everything goes
 * to SQLite for `bun run analyze`. A loopback /health endpoint reports freshness for monitoring.
 *
 *   bun run record
 */
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { startBlockFeed } from "../chain";
import { readBook, readVaultParams, vaultActive, log10 } from "../book";
import { TradeFeed } from "../trades";
import { profit, hasJev } from "./config";
import { Store, type BookRow, type TradeRow } from "./db";
import { RefFeed, QUIET_OK_MS } from "./ref";
import { TradeIndex, computeFeatures, refMids } from "./features";
import { JevForecaster, jevState, QUESTION } from "./jev";

const WINDOW = 400;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const logError = (...a: unknown[]) => console.error(new Date().toISOString(), ...a); // recent rows kept in memory for features (> the 100-block lookback)

log(`starting: rpc ${profit.rpcUrl}, db ${profit.dbPath}`);
const provider = new ethers.providers.StaticJsonRpcProvider(profit.rpcUrl, 143);
const params = await Kuru.ParamFetcher.getMarketParams(provider, profit.market);
const store = new Store(profit.dbPath, { flushMs: 1000 });
const startedAt = Date.now();

store.setMeta("market", {
  address: profit.market,
  pricePrecision: params.pricePrecision.toString(), sizePrecision: params.sizePrecision.toString(), tickSize: params.tickSize.toString(),
  minSize: params.minSize.toString(), takerFeeBps: Number(params.takerFeeBps.toString()), makerFeeBps: Number(params.makerFeeBps.toString()),
});
store.setMeta("recorder", { startedAt, venues: profit.venues, jevEvery: hasJev() ? profit.jevEvery : 0, question: QUESTION, model: profit.jevModelId });

// Reference venues: store a tick per venue at most every REF_TICK_MS.
const lastTick = new Map<string, number>();
const ref = new RefFeed(profit.venues, (venue, q) => {
  if (q.ts - (lastTick.get(venue) ?? 0) < profit.refTickMs) return;
  lastTick.set(venue, q.ts);
  store.addTick({ ts: q.ts, venue, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize });
});
ref.start();

const tradeFeed = new TradeFeed({ market: profit.market, url: profit.rpcUrl, sizeDec: log10(params.sizePrecision) });
const jev = hasJev() ? new JevForecaster() : null;

const books: BookRow[] = [];
let trades: TradeRow[] = [];
let useVault = false;
let busy = false;
const stats = { heads: 0, recorded: 0, skipped: 0, readErrors: 0, prints: 0, jevCalls: 0, jevErrors: 0, jevSkipped: 0, jevInflight: 0, jevLatencySum: 0, jevTokens: 0 };

async function onBlock(head: number) {
  stats.heads++;
  if (stats.heads % 200 === 0) readVaultParams(profit.rpcUrl, profit.market).then((v) => { useVault = vaultActive(v); }).catch(() => {});
  if (busy) { stats.skipped++; return; }
  busy = true;
  try {
    const t0 = performance.now();
    const b = await readBook(profit.rpcUrl, profit.market, params, { vault: useVault, timeoutMs: 2000 });
    const row: BookRow = {
      block: b.block, ts: Date.now(), bid: b.bid, ask: b.ask, mid: b.mid, spreadBps: b.spreadBps, imbalance: b.imbalance,
      bids: b.levels.bids, asks: b.levels.asks, depth: b.depthBps, ref: ref.snapshot(), readMs: Math.round(performance.now() - t0),
    };
    if (books.length && books.at(-1)!.block >= row.block) return; // the RPC answered from a block we already have
    store.addBook(row);
    books.push(row);
    if (books.length > WINDOW) books.shift();
    stats.recorded++;

    tradeFeed.poll(head).then(() => {
      for (const p of tradeFeed.drainPrints()) {
        const t: TradeRow = { block: p.block, logIndex: p.logIndex, tx: p.tx, side: p.side, price: p.price, size: p.size, maker: p.maker, taker: p.taker, orderId: p.orderId };
        store.addTrade(t);
        trades.push(t);
        stats.prints++;
      }
      const oldest = books[0]?.block ?? 0;
      if (trades.length && trades[0]!.block < oldest) trades = trades.filter((t) => t.block >= oldest);
    });

    if (jev && stats.recorded % profit.jevEvery === 0) forecast(row);
  } catch (e) {
    stats.readErrors++;
    if (stats.readErrors % 20 === 1) logError(`book read failed (${stats.readErrors} so far): ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

/** Off the block loop: at most `jevMaxInflight` calls at once; the rest are counted and dropped. */
function forecast(row: BookRow) {
  if (stats.jevInflight >= profit.jevMaxInflight) { stats.jevSkipped++; return; }
  const index = new TradeIndex(trades);
  const snap = books.slice();
  const state = jevState(computeFeatures(snap, snap.length - 1, index, refMids(snap)), row, index);
  stats.jevInflight++;
  jev!.forecast(state).then((f) => {
    stats.jevCalls++; stats.jevLatencySum += f.latencyMs; stats.jevTokens += f.inputTokens;
    store.addPrediction({ block: row.block, ts: row.ts, model: jev!.name, horizon: QUESTION.horizonBlocks, flatBps: QUESTION.flatBps, ...f, state, error: null });
  }).catch((e) => {
    stats.jevErrors++;
    const msg = (e as Error).message.slice(0, 300);
    if (stats.jevErrors % 20 === 1) logError(`jev failed (${stats.jevErrors} so far): ${msg}`);
    store.addPrediction({ block: row.block, ts: row.ts, model: jev!.name, horizon: QUESTION.horizonBlocks, flatBps: QUESTION.flatBps, pUp: 0, pDown: 0, pFlat: 0, choice: "error", confidence: null, latencyMs: 0, inputTokens: 0, state, error: msg });
  }).finally(() => { stats.jevInflight--; });
}

function health() {
  const last = books.at(-1);
  const ageMs = last ? Date.now() - last.ts : null;
  const ok = ageMs !== null && ageMs < profit.staleMs;
  return {
    ok, uptimeS: Math.round((Date.now() - startedAt) / 1000), lastBlock: last?.block ?? null, lastBookAgeMs: ageMs,
    lastMid: last ? Math.round(last.mid * 1e7) / 1e7 : null, lastSpreadBps: last ? Math.round(last.spreadBps * 100) / 100 : null,
    stats: { ...stats, jevAvgLatencyMs: stats.jevCalls ? Math.round(stats.jevLatencySum / stats.jevCalls) : null, jevUsd: Math.round((stats.jevTokens / 1e6) * profit.jevUsdPerMTok * 1e4) / 1e4 },
    venues: ref.statuses().map((s) => {
      const lastMessageAgeMs = s.lastMessageTs ? Date.now() - s.lastMessageTs : null;
      return { ...s, live: s.connected && s.quotes > 0 && lastMessageAgeMs !== null && lastMessageAgeMs <= QUIET_OK_MS, lastQuoteAgeMs: s.lastQuoteTs ? Date.now() - s.lastQuoteTs : null, lastMessageAgeMs };
    }),
    db: profit.dbPath,
    // The process's own memory. systemd's "Memory:" also counts the page cache of the growing
    // database file, which the kernel reclaims under pressure; a real leak shows up here instead.
    mem: (() => { const m = process.memoryUsage(); return { rssMb: Math.round(m.rss / 1e6), heapUsedMb: Math.round(m.heapUsed / 1e6) }; })(),
  };
}

const server = Bun.serve({
  hostname: profit.healthHost,
  port: profit.healthPort,
  fetch(req) {
    if (new URL(req.url).pathname !== "/health") return new Response("not found", { status: 404 });
    const h = health();
    return Response.json(h, { status: h.ok ? 200 : 503 });
  },
});

const summary = setInterval(() => {
  const h = health();
  const venues = h.venues.map((v) => `${v.venue}:${v.live ? "live" : v.connected ? "silent" : "down"}`).join(" ");
  log(`block ${h.lastBlock} mid ${h.lastMid} spread ${h.lastSpreadBps}bps · rows ${stats.recorded} skipped ${stats.skipped} prints ${stats.prints} · jev ${stats.jevCalls} ok ${stats.jevErrors} err ${h.stats.jevAvgLatencyMs ?? "-"}ms $${h.stats.jevUsd} · rss ${h.mem.rssMb}MB heap ${h.mem.heapUsedMb}MB · ${venues}`);
}, 60_000);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: flushing and closing`);
  clearInterval(summary);
  ref.stop();
  server.stop();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`profit recorder · market ${profit.market} · fees taker ${params.takerFeeBps} maker ${params.makerFeeBps} bps · venues ${profit.venues.map((v) => `${v.venue}:${v.symbol}`).join(",")} · jev ${jev ? `${jev.name} every ${profit.jevEvery} blocks, horizon ${QUESTION.horizonBlocks} blocks, flat within ${QUESTION.flatBps} bps` : "off (no TYPESAFE_AI_API_KEY or JEV_EVERY=0)"} · db ${profit.dbPath} · health http://${profit.healthHost}:${profit.healthPort}/health`);
startBlockFeed((b) => { onBlock(b); });
