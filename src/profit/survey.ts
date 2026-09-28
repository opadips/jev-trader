/**
 * Kuru market survey: which markets actually trade, measured on chain.
 *
 * 1. Every Kuru `Trade` log over the last `blocks` blocks, with no address filter, so any market
 *    that traded shows up (plus a list of markets Kuru announced, in case one was quiet).
 * 2. For each candidate: market params (skips anything that is not a Kuru order book), token
 *    symbols, and a few order-book snapshots.
 * 3. A ranking by USD volume per hour, with trades per hour, distinct takers and makers, spread,
 *    depth and whether a reference price exists on the big exchanges.
 *
 * Read-only and paced (`--rps`, default 2) so the recorder keeps its share of the public RPC.
 *
 *   bun run src/profit/survey.ts --json-out survey.json
 */
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { readBook, log10, toFloat } from "../book";
import { TRADE_TOPIC0, TRADE_PRICE_DEC } from "../trades";
import { quantile } from "./stats";
import { profit } from "./config";

/** Markets Kuru lists as active (its own announcement); the log scan finds any others that trade. */
export const KNOWN_MARKETS = [
  "0x065c9d28e428a0db40191a54d33d5b7c71a9c394", // MON/USDC (the control market)
  "0x131a2e70a5b31a517a74b8c567149bc294470da9", // MON/AUSD
  "0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0", // cbBTC/USDC
  "0xa6afd386135b7d41a6c40c525abc4a1019b0d132", // WETH/USDC
  "0x851145eaefdc37956b08da829fa31722199f3f07", // XAUt0/USDC
  "0x8cf49e35d73b19433ff4d4421637aabb680dc9cc", // AUSD/USDC
  "0xe7a4f90369b48d8f5b61f2fd519ec563c11e4b2d", // emo/MON
];

export interface RawTradeLog { address: string; blockNumber: string; data: string }

export interface MarketActivity { address: string; trades: number; baseVolume: number; quoteVolume: number; takers: number; makers: number; medianTradeBase: number }

/** Aggregate raw Trade logs per market. `sizeDecOf` gives each market's size decimals (null: unknown market, skipped). */
export function summarizeTrades(logs: RawTradeLog[], sizeDecOf: (address: string) => number | null): MarketActivity[] {
  const by = new Map<string, { sizes: number[]; quote: number; takers: Set<string>; makers: Set<string> }>();
  for (const l of logs) {
    const addr = l.address.toLowerCase();
    const dec = sizeDecOf(addr);
    if (dec === null) continue;
    const d = l.data.startsWith("0x") ? l.data.slice(2) : l.data;
    if (d.length < 64 * 8) continue;
    const word = (i: number) => BigInt("0x" + d.slice(i * 64, (i + 1) * 64));
    const price = toFloat(word(3), TRADE_PRICE_DEC), size = toFloat(word(7), dec);
    if (!(size > 0)) continue;
    let m = by.get(addr);
    if (!m) by.set(addr, (m = { sizes: [], quote: 0, takers: new Set(), makers: new Set() }));
    m.sizes.push(size);
    m.quote += size * price;
    m.makers.add("0x" + d.slice(64 + 24, 128));
    m.takers.add("0x" + d.slice(5 * 64 + 24, 6 * 64));
  }
  return [...by].map(([address, m]) => ({
    address, trades: m.sizes.length, baseVolume: m.sizes.reduce((s, x) => s + x, 0), quoteVolume: m.quote,
    takers: m.takers.size, makers: m.makers.size, medianTradeBase: quantile(m.sizes, 0.5),
  }));
}

/** Which asset on the big exchanges tracks this market's base token, if any. */
export function referenceFor(base: string, quote: string): string | null {
  const stable = (s: string) => /^(usdc|usdt|usdt0|ausd|dai|usd.*)$/i.test(s);
  if (stable(base) && stable(quote)) return null; // stable/stable: nothing to lead it
  const b = base.toUpperCase().replace(/^W(?=ETH$|BTC$|MON$)/, "").replace(/^CB(?=BTC$)/, "");
  if (["BTC", "ETH", "MON", "SOL"].includes(b)) return b;
  if (/^XAUT/.test(b)) return "XAUT";
  return null;
}

// ---------------------------------------------------------------------------------------------

if (import.meta.main) {
  const { values: args } = parseArgs({ options: { blocks: { type: "string", default: "12000" }, rps: { type: "string", default: "2" }, "json-out": { type: "string" } } });
  const url = profit.rpcUrl, gap = 1000 / Number(args.rps);
  let last = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const wait = last + gap - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  };
  const iface = new ethers.utils.Interface(OrderBookAbi.abi);
  const call = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"]);

  const head = parseInt(await rpc<string>("eth_blockNumber", []), 16);
  const from = head - Number(args.blocks) + 1;
  const logs: RawTradeLog[] = [];
  let scanError: string | null = null;
  for (let b = from; b <= head; b += 100) {
    try {
      logs.push(...(await rpc<RawTradeLog[]>("eth_getLogs", [{ topics: [TRADE_TOPIC0], fromBlock: "0x" + b.toString(16), toBlock: "0x" + Math.min(head, b + 99).toString(16) }])));
    } catch (e) { scanError = (e as Error).message; break; }
  }
  const t0 = parseInt((await rpc<any>("eth_getBlockByNumber", ["0x" + from.toString(16), false])).timestamp, 16);
  const t1 = parseInt((await rpc<any>("eth_getBlockByNumber", ["0x" + head.toString(16), false])).timestamp, 16);
  const hours = Math.max(1, t1 - t0) / 3600;

  const symbol = async (token: string) => {
    if (token === ethers.constants.AddressZero) return "MON";
    try {
      const r = await call(token, "0x95d89b41");
      try { return ethers.utils.defaultAbiCoder.decode(["string"], r)[0] as string; } catch { return ethers.utils.parseBytes32String(r); }
    } catch { return token.slice(0, 8); }
  };

  const candidates = [...new Set([...KNOWN_MARKETS, ...logs.map((l) => l.address.toLowerCase())])];
  const info = new Map<string, { base: string; quote: string; sizeDec: number; params: any; takerFeeBps: number; makerFeeBps: number; tick: number }>();
  for (const addr of candidates) {
    try {
      const r = iface.decodeFunctionResult("getMarketParams", await call(addr, iface.getSighash("getMarketParams")));
      const params = { pricePrecision: r[0], sizePrecision: r[1], tickSize: r[6] };
      info.set(addr, {
        base: await symbol(r[2]), quote: await symbol(r[4]), sizeDec: log10(r[1]), params,
        takerFeeBps: Number(r[9]), makerFeeBps: Number(r[10]), tick: Number(r[6].toString()) / Number(r[0].toString()),
      });
    } catch { /* not a Kuru order book */ }
  }
  const activity = new Map(summarizeTrades(logs, (a) => info.get(a)?.sizeDec ?? null).map((m) => [m.address, m]));

  // USD per unit of quote token: stables are $1, MON is priced from the MON/USDC book
  let monUsd = NaN;
  const books = new Map<string, any[]>();
  for (const addr of info.keys()) {
    const snaps: any[] = [];
    for (let i = 0; i < 3; i++) {
      try { snaps.push(await readBook(url, addr, info.get(addr)!.params)); } catch { /* empty side */ }
      if (i < 2) await Bun.sleep(5000 / 3);
    }
    books.set(addr, snaps);
    if (addr === KNOWN_MARKETS[0] && snaps.length) monUsd = snaps.at(-1).mid;
  }
  const usdPerQuote = (q: string) => (/^(usdc|usdt|usdt0|ausd|dai)$/i.test(q) ? 1 : q.toUpperCase() === "MON" ? monUsd : NaN);

  const rows = [...info].map(([address, m]) => {
    const a = activity.get(address);
    const s = books.get(address) ?? [];
    const last = s.at(-1);
    const u = usdPerQuote(m.quote);
    const depthUsd = (band: string) => (last ? (last.depthBps[band].bid + last.depthBps[band].ask) * last.mid * u : NaN);
    return {
      address, pair: `${m.base}/${m.quote}`, reference: referenceFor(m.base, m.quote),
      tradesPerHour: (a?.trades ?? 0) / hours, usdPerHour: ((a?.quoteVolume ?? 0) * u) / hours,
      takers: a?.takers ?? 0, makers: a?.makers ?? 0, medianTradeUsd: a && last ? a.medianTradeBase * last.mid * u : NaN,
      spreadBps: s.length ? quantile(s.map((b) => b.spreadBps), 0.5) : NaN, tickBps: last ? (m.tick / last.mid) * 10_000 : NaN,
      touchUsd: last ? ((last.levels.bids[0]?.[1] ?? 0) + (last.levels.asks[0]?.[1] ?? 0)) * last.mid * u : NaN,
      depth10Usd: depthUsd("10"), depth50Usd: depthUsd("50"), takerFeeBps: m.takerFeeBps, makerFeeBps: m.makerFeeBps, bookSnapshots: s.length,
    };
  }).sort((a, b) => (b.usdPerHour || 0) - (a.usdPerHour || 0));

  const out = { generatedAt: new Date().toISOString(), blocks: Number(args.blocks), hours, logs: logs.length, scanError, monUsd, markets: rows };
  if (args["json-out"]) await Bun.write(args["json-out"], JSON.stringify(out, null, 2));
  const f = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
  console.log(`Kuru market survey: ${logs.length} Trade logs over the last ${args.blocks} blocks (${f(hours, 2)} h)${scanError ? `; scan stopped early: ${scanError}` : ""}\n`);
  console.log("pair            address      $/h        trades/h takers makers median$  spread  tick   touch$     depth10bps$ depth50bps$ ref   fees t/m");
  for (const r of rows) {
    console.log(`${r.pair.padEnd(15)} ${r.address.slice(0, 10)}  ${f(r.usdPerHour).padStart(10)} ${f(r.tradesPerHour).padStart(8)} ${String(r.takers).padStart(6)} ${String(r.makers).padStart(6)} ${f(r.medianTradeUsd).padStart(8)} ${f(r.spreadBps, 2).padStart(6)} ${f(r.tickBps, 2).padStart(5)} ${f(r.touchUsd).padStart(10)} ${f(r.depth10Usd).padStart(11)} ${f(r.depth50Usd).padStart(11)} ${(r.reference ?? "none").padEnd(5)} ${r.takerFeeBps}/${r.makerFeeBps}`);
  }
}
