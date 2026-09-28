/**
 * Records the extra Kuru markets (markets.ts) next to the MON-USDC control recorder, in its own
 * process so the control keeps running exactly as before. Signs nothing.
 *
 * Request budget (public RPC, ~25/s shared with the control recorder's ~13/s):
 *   - new blocks: WebSocket newHeads, HTTP polling backstop once a second (1/s)
 *   - every SAMPLE_EVERY blocks, ONE batched request: getL2Book for every market (+ getVaultParams
 *     where a market's AMM vault is live) and ONE eth_getLogs for every market's Trade logs since
 *     the last sample (address list filter). At SAMPLE_EVERY = 2 and 4 markets: ~6.7 book calls/s
 *     + ~1.7 log calls/s, in ~1.7 HTTP requests/s.
 * Trade logs cover every block; only book snapshots are sampled.
 *
 *   bun run src/profit/multi-recorder.ts
 */
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { startBlockFeed } from "../chain";
import { SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS, buildBook, decodeVaultParams, readVaultParams, vaultActive, log10 } from "../book";
import { TRADE_TOPIC0, decodeTradePrint, type RawLog } from "../trades";
import { profit } from "./config";
import { Store, type BookRow } from "./db";
import { RefFeed, QUIET_OK_MS } from "./ref";
import { EXTRA_MARKETS, REFERENCE_VENUES, SAMPLE_EVERY, dbPathFor, type ExtraMarket } from "./markets";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const HEALTH_PORT = Number(process.env.MARKETS_HEALTH_PORT ?? 3102);
const MAX_LOG_RANGE = 100;

interface Recorded {
  m: ExtraMarket;
  params: Kuru.MarketParams;
  sizeDec: number;
  store: Store;
  ref: RefFeed;
  useVault: boolean;
  lastBlock: number;
  stats: { rows: number; readErrors: number; prints: number };
  last: BookRow | null;
}

if (!EXTRA_MARKETS.length) {
  log("no extra markets configured; exiting");
  process.exit(0);
}

const provider = new ethers.providers.StaticJsonRpcProvider(profit.rpcUrl, 143);
const markets: Recorded[] = [];
for (const m of EXTRA_MARKETS) {
  try {
    const params = await Kuru.ParamFetcher.getMarketParams(provider, m.address);
    const store = new Store(dbPathFor(m.slug), { flushMs: 1000 });
    store.setMeta("market", {
      address: m.address, pair: m.pair, reference: m.reference, sampleEvery: SAMPLE_EVERY,
      pricePrecision: params.pricePrecision.toString(), sizePrecision: params.sizePrecision.toString(), tickSize: params.tickSize.toString(),
      minSize: params.minSize.toString(), takerFeeBps: Number(params.takerFeeBps.toString()), makerFeeBps: Number(params.makerFeeBps.toString()),
    });
    const lastTick = new Map<string, number>();
    const ref = new RefFeed(REFERENCE_VENUES[m.reference]!, (venue, q) => {
      if (q.ts - (lastTick.get(venue) ?? 0) < profit.refTickMs) return;
      lastTick.set(venue, q.ts);
      store.addTick({ ts: q.ts, venue, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize });
    });
    ref.start();
    const useVault = await readVaultParams(profit.rpcUrl, m.address).then(vaultActive).catch(() => false);
    markets.push({ m, params, sizeDec: log10(params.sizePrecision), store, ref, useVault, lastBlock: 0, stats: { rows: 0, readErrors: 0, prints: 0 }, last: null });
    log(`${m.pair} ${m.address}: fees ${params.takerFeeBps}/${params.makerFeeBps} bps, vault ${useVault ? "live" : "off"}, reference ${m.reference}, db ${dbPathFor(m.slug)}`);
  } catch (e) {
    log(`${m.pair} ${m.address}: skipped (${(e as Error).message.slice(0, 120)})`);
  }
}
const byAddress = new Map(markets.map((r) => [r.m.address.toLowerCase(), r]));
const startedAt = Date.now();
const stats = { heads: 0, samples: 0, skipped: 0, requestErrors: 0, logErrors: 0 };
let busy = false, logsFrom = 0;

async function post(body: unknown): Promise<any> {
  const res = await fetch(profit.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  return res.json();
}

async function onBlock(head: number) {
  stats.heads++;
  if (head % SAMPLE_EVERY !== 0) return;
  if (busy) { stats.skipped++; return; }
  busy = true;
  try {
    // one batch: each market's book (and vault params where the vault is live)
    const calls: unknown[] = [];
    markets.forEach((r, i) => {
      calls.push({ jsonrpc: "2.0", id: 2 * i, method: "eth_call", params: [{ to: r.m.address, data: SEL_GET_L2_BOOK }, "latest"] });
      if (r.useVault) calls.push({ jsonrpc: "2.0", id: 2 * i + 1, method: "eth_call", params: [{ to: r.m.address, data: SEL_GET_VAULT_PARAMS }, "latest"] });
    });
    const t0 = performance.now();
    const out: any[] = await post(calls);
    const readMs = Math.round(performance.now() - t0);
    const byId = new Map((Array.isArray(out) ? out : [out]).map((x) => [x.id, x]));
    const ts = Date.now();
    markets.forEach((r, i) => {
      try {
        const l2 = byId.get(2 * i);
        if (!l2?.result) throw new Error(l2?.error?.message ?? "no result");
        const v = r.useVault ? byId.get(2 * i + 1)?.result : undefined;
        const b = buildBook(l2.result, r.params, v ? decodeVaultParams(v) : undefined);
        if (r.last && b.block <= r.last.block) return;
        const row: BookRow = { block: b.block, ts, bid: b.bid, ask: b.ask, mid: b.mid, spreadBps: b.spreadBps, imbalance: b.imbalance, bids: b.levels.bids, asks: b.levels.asks, depth: b.depthBps, ref: r.ref.snapshot(ts), readMs };
        r.store.addBook(row);
        r.last = row;
        r.stats.rows++;
      } catch (e) {
        r.stats.readErrors++;
        if (r.stats.readErrors % 20 === 1) log(`${r.m.pair}: book read failed (${r.stats.readErrors} so far): ${(e as Error).message}`);
      }
    });
    stats.samples++;

    // one getLogs for every market's trades since the last sample (never more than 100 blocks)
    const from = logsFrom ? logsFrom : head - SAMPLE_EVERY + 1;
    const fromBlock = Math.max(from, head - MAX_LOG_RANGE + 1);
    const logs: RawLog[] | undefined = (await post({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: markets.map((r) => r.m.address), topics: [TRADE_TOPIC0], fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + head.toString(16) }] })).result;
    if (!logs) { stats.logErrors++; return; } // retried from the same block next sample
    for (const l of logs) {
      const r = l.address && byAddress.get(l.address.toLowerCase());
      if (!r || l.removed) continue;
      const p = decodeTradePrint(l, r.sizeDec);
      if (!p) continue;
      r.store.addTrade({ block: p.block, logIndex: p.logIndex, tx: p.tx, side: p.side, price: p.price, size: p.size, maker: p.maker, taker: p.taker, orderId: p.orderId });
      r.stats.prints++;
    }
    logsFrom = head + 1;
  } catch (e) {
    stats.requestErrors++;
    if (stats.requestErrors % 20 === 1) log(`sample failed (${stats.requestErrors} so far): ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

// vault state can change; re-check each market every ~10 minutes
setInterval(() => {
  for (const r of markets) readVaultParams(profit.rpcUrl, r.m.address).then((v) => { r.useVault = vaultActive(v); }).catch(() => {});
}, 600_000);

function health() {
  const now = Date.now();
  const list = markets.map((r) => ({
    slug: r.m.slug, pair: r.m.pair, rows: r.stats.rows, prints: r.stats.prints, readErrors: r.stats.readErrors,
    lastBlock: r.last?.block ?? null, lastBookAgeMs: r.last ? now - r.last.ts : null, lastMid: r.last?.mid ?? null, lastSpreadBps: r.last ? Math.round(r.last.spreadBps * 100) / 100 : null,
    venues: r.ref.statuses().map((s) => ({ venue: s.venue, symbol: s.symbol, live: s.connected && s.quotes > 0 && s.lastMessageTs !== null && now - s.lastMessageTs <= QUIET_OK_MS })),
  }));
  const ok = list.length > 0 && list.every((m) => m.lastBookAgeMs !== null && m.lastBookAgeMs < profit.staleMs);
  const m = process.memoryUsage();
  return { ok, uptimeS: Math.round((now - startedAt) / 1000), sampleEvery: SAMPLE_EVERY, stats, markets: list, mem: { rssMb: Math.round(m.rss / 1e6), heapUsedMb: Math.round(m.heapUsed / 1e6) } };
}

const server = Bun.serve({
  hostname: profit.healthHost,
  port: HEALTH_PORT,
  fetch(req) {
    if (new URL(req.url).pathname !== "/health") return new Response("not found", { status: 404 });
    const h = health();
    return Response.json(h, { status: h.ok ? 200 : 503 });
  },
});

const summary = setInterval(() => {
  Bun.gc(true);
  const h = health();
  log(`samples ${stats.samples} skipped ${stats.skipped} errors ${stats.requestErrors}/${stats.logErrors} · rss ${h.mem.rssMb}MB · ` + h.markets.map((m) => `${m.pair}: ${m.rows} rows ${m.prints} prints ${m.readErrors} err, ${m.venues.filter((v) => v.live).map((v) => v.venue).join("+") || "no ref"}`).join(" · "));
}, 60_000);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: flushing and closing`);
  clearInterval(summary);
  server.stop();
  for (const r of markets) { r.ref.stop(); r.store.close(); }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`markets recorder · ${markets.length} markets · book sample every ${SAMPLE_EVERY} blocks · health http://${profit.healthHost}:${HEALTH_PORT}/health`);
startBlockFeed((b) => { onBlock(b); }, 1000);
