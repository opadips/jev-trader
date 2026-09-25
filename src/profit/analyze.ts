/**
 * Phase 1 report over what the recorder captured.
 *
 *   bun run analyze                         # last 72 hours
 *   bun run analyze --hours 24              # last 24 hours ("all" for everything; ~1 GB of RAM per 2M rows)
 *   bun run analyze --json > report.json    # machine-readable
 *   bun run analyze --db path --gas-mon 0.036 --order-mon 200
 *
 * Gas is expressed in bps of one order's notional (gas MON / order MON), so it does not depend on price.
 */
import { parseArgs } from "node:util";
import { profit } from "./config";
import { Store } from "./db";
import { coverage, evaluateForecasts, leadLag, makerMarkouts, marketStats, takerArb } from "./analysis";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: profit.dbPath },
    hours: { type: "string", default: "72" },
    "gas-mon": { type: "string", default: "0.036" },
    "order-mon": { type: "string", default: "200" },
    json: { type: "boolean", default: false },
  },
});

const store = new Store(args.db!, { readonly: true });
const meta = store.meta() as { market?: { takerFeeBps: number; makerFeeBps: number } };
const lastTs = store.lastTs();
const fromTs = args.hours === "all" || lastTs === null ? 0 : lastTs - Number(args.hours) * 3_600_000;
const books = store.books({ fromTs, lite: true });
if (books.length < 200) {
  console.log(`only ${books.length} book rows in ${args.db}; let the recorder run longer (an hour is ~12,000 rows).`);
  process.exit(0);
}
const trades = store.trades(books[0]!.block, books.at(-1)!.block);
const preds = store.predictions({ fromBlock: books[0]!.block });
const takerFeeBps = meta.market?.takerFeeBps ?? NaN, makerFeeBps = meta.market?.makerFeeBps ?? NaN;
const gasBps = (Number(args["gas-mon"]) / Number(args["order-mon"])) * 10_000;

const report = {
  costs: { takerFeeBps, makerFeeBps, gasBpsPerTx: gasBps, orderMon: Number(args["order-mon"]) },
  coverage: coverage(books),
  market: marketStats(books, trades),
  makerMarkouts: makerMarkouts(books, trades, [1, 10, 33, 100, 333], makerFeeBps || 0),
  leadLag: leadLag(books),
  takerArb: takerArb(books, { thresholdsBps: [0, 2, 5, 10, 20], horizon: 33, takerFeeBps: takerFeeBps || 0, gasBps }),
  forecasts: evaluateForecasts(books, trades, preds),
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
const c = report.coverage!, m = report.market;

console.log(`\n== Coverage`);
console.log(`${c.rows} rows, blocks ${c.fromBlock}..${c.toBlock}, ${f(c.hours, 1)} h, ${pct(c.blockCoverage)} of blocks recorded (${c.gaps} gaps)`);
console.log(`reference venues fresh: ${Object.entries(c.venueFresh).map(([v, s]) => `${v} ${pct(s)}`).join(", ") || "none"}`);

console.log(`\n== Costs`);
console.log(`taker fee ${f(takerFeeBps)} bps, maker fee ${f(makerFeeBps)} bps, gas ${f(gasBps)} bps per tx on ${args["order-mon"]} MON`);

console.log(`\n== Market`);
console.log(`spread p10/p50/p90 ${f(m.spreadBps.p10)} / ${f(m.spreadBps.p50)} / ${f(m.spreadBps.p90)} bps; median touch ${f(m.touchMon.bid, 0)} MON bid, ${f(m.touchMon.ask, 0)} MON ask`);
console.log(`${f(m.printsPerHour, 0)} prints/h, ${f(m.monPerHour, 0)} MON/h ($${f(m.usdPerHour, 0)}/h), median print ${f(m.medianPrintMon, 0)} MON, taker buys ${pct(m.takerBuyShare)}`);
console.log(`${m.distinctTakers} distinct takers, ${m.distinctMakers} distinct makers; 100-block move std ${f(m.move100BlocksBps)} bps`);

console.log(`\n== Would a resting order pay? (maker P&L after the maker fee, bps of mid)`);
for (const r of report.makerMarkouts) console.log(`  ${String(r.horizon).padStart(3)} blocks later: capture ${f(r.captureBps)} - adverse ${f(r.adverseBps)} = net ${f(r.netBps)} (median ${f(r.netMedianBps)}), n=${r.n}`);
console.log(`  compare with gas ${f(gasBps)} bps per quote placed; every re-quote costs that again.`);

const ll = report.leadLag;
console.log(`\n== Does Kuru follow other exchanges?`);
if (!ll.usableRows) console.log("  no reference data recorded (check REF_VENUES and /health)");
else {
  console.log(`  strongest link: reference move at t vs Kuru move at t${ll.best && ll.best.lag >= 0 ? "+" : ""}${ll.best?.lag ?? "?"} rows, corr ${f(ll.best?.corr, 3)}`);
  console.log(`  share of a reference move Kuru has absorbed after: ${ll.catchUp.map((x) => `${x.rows} rows ${f(x.beta, 2)}`).join(", ")}`);
}

console.log(`\n== Taker arbitrage vs reference (enter a row late, mark 33 rows later, after fee and gas)`);
for (const r of report.takerArb) console.log(`  edge > ${String(r.thresholdBps).padStart(2)} bps: ${r.trades} trades (${f(r.perHour, 1)}/h), net ${f(r.netBps)} bps each, win ${pct(r.hitRate)}`);

console.log(`\n== Forecasts`);
const fc = report.forecasts as any;
if (!fc) console.log("  none recorded (set TYPESAFE_AI_API_KEY and JEV_EVERY)");
else if (fc.note) console.log(`  ${fc.n} labelled: ${fc.note}`);
else {
  console.log(`  horizon ${fc.horizon} blocks, flat band ${fc.flatBps} bps; ${fc.n} labelled, testing on the last ${fc.testN} (up ${pct(fc.testClassShare.up)}, down ${pct(fc.testClassShare.down)}, flat ${pct(fc.testClassShare.flat)})`);
  console.log(`  jev latency p50 ${f(fc.jevLatencyMs.p50, 0)} ms p95 ${f(fc.jevLatencyMs.p95, 0)} ms, errors ${pct(fc.jevErrorRate)}`);
  console.log(`  ${"model".padEnd(9)} ${"acc".padStart(6)} ${"logloss".padStart(8)} ${"brier".padStart(6)}   signed move when |pUp-pDown| > 0 / 0.2 / 0.5`);
  for (const [name, s] of Object.entries(fc.models) as [string, any][]) {
    const d = (th: number) => { const x = s.directional.find((y: any) => y.threshold === th); return x ? `${f(x.meanSignedBps)} (n=${x.n})` : "n/a"; };
    console.log(`  ${name.padEnd(9)} ${pct(s.accuracy).padStart(6)} ${f(s.logLoss, 3).padStart(8)} ${f(s.brier, 3).padStart(6)}   ${d(0)} / ${d(0.2)} / ${d(0.5)}`);
  }
  console.log(`  a taker round trip costs about spread + 2 x (taker fee + gas) = ${f(m.spreadBps.p50 + 2 * ((takerFeeBps || 0) + gasBps))} bps at the median spread`);
}
console.log("");
store.close();
