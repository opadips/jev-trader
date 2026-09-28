/**
 * Backtest report: every strategy variant on the earlier 60% of the recording, the best one picked
 * there, then all of them scored on the later 40% they were not tuned on.
 *
 *   bun run backtest                          # last 24 h
 *   bun run backtest --hours 72 --gas-mon 0.036
 *   bun run backtest --json-out backtest.json # text on stdout and JSON to a file
 */
import { parseArgs } from "node:util";
import { profit } from "./config";
import { Store, timeWindow } from "./db";
import { fairValues } from "./analysis";
import { DEFAULT_COSTS, grid, lagTaker, refMaker, splitByTime, type Costs, type LagParams, type MakerParams, type Result } from "./backtest";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: profit.dbPath },
    hours: { type: "string", default: "24" },
    day: { type: "string" },
    "gas-mon": { type: "string", default: String(DEFAULT_COSTS.gasMon) },
    "latency-blocks": { type: "string", default: String(DEFAULT_COSTS.latencyBlocks) },
    "mon-usd": { type: "string" },
    "json-out": { type: "string" },
  },
});

async function out(json: unknown, text: string) {
  if (args["json-out"]) await Bun.write(args["json-out"], JSON.stringify(json, null, 2));
  console.log(text);
}

if (!(await Bun.file(args.db!).exists())) {
  const note = `no recording yet: ${args.db} does not exist`;
  await out({ note }, note);
  process.exit(0);
}
const store = new Store(args.db!, { readonly: true });
const win = timeWindow({ hours: args.hours, day: args.day }, store.lastTs());
const books = store.books({ fromTs: win.fromTs, toTs: win.toTs });
if (books.length < 2000) {
  const note = `only ${books.length} book rows; backtests need at least 2,000 (~10 minutes)`;
  await out({ note }, note);
  process.exit(0);
}
const trades = store.trades(books[0]!.block, books.at(-1)!.block);
const allPreds = store.predictions({ fromBlock: books[0]!.block });
const latestModel = allPreds.at(-1)?.model;
const preds = allPreds.filter((p) => p.model === latestModel && !p.error);
const meta = store.meta() as { market?: { takerFeeBps: number; makerFeeBps: number; tickSize: string; pricePrecision: string; sizePrecision: string; minSize: string; reference?: string; sampleEvery?: number } };
// the fair-value basis stays 1,000 blocks on markets sampled every few blocks
const basisRows = Math.round(1000 / (meta.market?.sampleEvery ?? 1));
store.close();

// Gas is paid in MON: markets priced in MON use their own mid; others use the control's last MON price.
const monBased = !meta.market?.reference || meta.market.reference === "MON";
let monUsd: number | undefined;
if (args["mon-usd"]) monUsd = Number(args["mon-usd"]);
else if (!monBased && (await Bun.file(profit.dbPath).exists())) {
  const c = new Store(profit.dbPath, { readonly: true });
  const t = c.lastTs();
  monUsd = t === null ? undefined : c.books({ fromTs: t, lite: true }).at(-1)?.mid;
  c.close();
}

/** Order sizes are set in USD so markets compare ($5 is about Kuru's 200 MON minimum at $0.026), never below the market's minimum. */
const minSize = meta.market?.minSize && meta.market.sizePrecision ? Number(meta.market.minSize) / Number(meta.market.sizePrecision) : 0;
const sizeFor = (usd: number) => Math.max(usd / books[0]!.mid, minSize);

const m = meta.market;
const costs: Costs = {
  latencyBlocks: Number(args["latency-blocks"]),
  gasMon: Number(args["gas-mon"]),
  takerFeeBps: m?.takerFeeBps ?? 0,
  makerFeeBps: m?.makerFeeBps ?? 0,
  tick: m?.tickSize && m?.pricePrecision ? Number(m.tickSize) / Number(m.pricePrecision) : DEFAULT_COSTS.tick,
  monUsd,
};

const { train, test } = splitByTime(books);
const fair = { train: fairValues(train, basisRows), test: fairValues(test, basisRows) };
const tradesIn = (rows: typeof books) => { const lo = rows[0]!.block, hi = rows.at(-1)!.block; return trades.filter((t) => t.block >= lo && t.block <= hi); };
const tr = { train: tradesIn(train), test: tradesIn(test) };

type Family = { name: string; variants: Record<string, unknown>[]; run: (rows: typeof books, part: "train" | "test", v: Record<string, unknown>) => Result };
const families: Family[] = [
  {
    name: "take the lag",
    // Day 1: only gaps of 10 to 20+ bps paid, and gas per tx is fixed, so large sizes matter.
    variants: grid<Record<string, unknown>>({ thresholdBps: [5, 8, 12, 16, 20, 30], sizeUsd: [5, 50, 250], holdBlocks: [3, 10, 33], jev: preds.length ? [false, true] : [false] }),
    run: (rows, part, v) => lagTaker(rows, {
      thresholdBps: v.thresholdBps as number, holdBlocks: v.holdBlocks as number, sizeMon: sizeFor(v.sizeUsd as number),
      jev: v.jev ? { preds, maxAgeBlocks: 60, minAgreement: 0.2 } : undefined,
    }, costs, fair[part]),
  },
  {
    name: "quote around a fair price",
    // Day 1: tight quotes were picked off (negative before gas) and re-quoting burned gas; try wider and calmer.
    variants: grid<Record<string, unknown>>({ useReference: [true, false], halfSpreadBps: [2, 3, 5, 8, 12], sizeUsd: [5, 50], requoteBps: [2, 4, 8] }),
    run: (rows, part, v) => {
      const size = sizeFor(v.sizeUsd as number);
      return refMaker(rows, tr[part], { useReference: v.useReference as boolean, halfSpreadBps: v.halfSpreadBps as number, requoteBps: v.requoteBps as number, sizeMon: size, maxInventoryMon: 25 * size }, costs, fair[part]);
    },
  },
];

const round3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const t0 = performance.now();
const report = {
  generatedAt: new Date().toISOString(),
  window: win.label,
  rows: books.length,
  hours: { train: train.length > 1 ? (train.at(-1)!.ts - train[0]!.ts) / 3_600_000 : 0, test: test.length > 1 ? (test.at(-1)!.ts - test[0]!.ts) / 3_600_000 : 0 },
  costs, jevModel: preds.length ? latestModel : null,
  families: families.map((f) => {
    const rows = f.variants.map((v) => ({ variant: v, train: f.run(train, "train", v), test: f.run(test, "test", v) }));
    rows.sort((a, b) => b.train.pnlPerHourUsd - a.train.pnlPerHourUsd);
    const brief = (r: Result) => ({ pnlPerHourUsd: r.pnlPerHourUsd, pnlUsd: r.pnlUsd, txs: r.txs, fills: r.fills, winRate: r.winRate, avgNetBps: r.avgNetBps, gasUsd: r.gasUsd, maxDrawdownUsd: r.maxDrawdownUsd, maxInventoryMon: r.maxInventoryMon });
    return {
      name: f.name,
      chosen: { variant: rows[0]!.variant, train: brief(rows[0]!.train), test: brief(rows[0]!.test) },
      top: rows.slice(0, 5).map((r) => ({ variant: r.variant, train: brief(r.train), test: brief(r.test) })),
      variantsPositiveOnTest: rows.filter((r) => r.test.pnlUsd > 0).length,
      variants: rows.length,
      /** Every variant, compactly: [settings, tuning $/h, unseen $/h, unseen transactions]. */
      all: rows.map((r) => [r.variant, round3(r.train.pnlPerHourUsd), round3(r.test.pnlPerHourUsd), r.test.txs]),
    };
  }),
  seconds: 0,
};
report.seconds = Math.round((performance.now() - t0) / 100) / 10;

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const show = (v: Record<string, unknown>) => Object.entries(v).map(([k, x]) => `${k}=${x}`).join(" ");
const L: string[] = [];
L.push(`Backtest (${win.label}) over ${books.length} rows: tuned on the first ${f(report.hours.train, 1)} h, tested on the last ${f(report.hours.test, 1)} h.`);
L.push(`Costs: ${costs.latencyBlocks} block latency, ${costs.gasMon} MON gas per tx${monUsd ? ` (MON at $${monUsd.toFixed(4)})` : ""}, fees ${costs.takerFeeBps}/${costs.makerFeeBps} bps (taker/maker). Jev forecasts: ${preds.length ? `${preds.length} from ${latestModel}` : "none"}.`);
for (const fam of report.families) {
  const c = fam.chosen;
  L.push("", `== ${fam.name} (${fam.variants} variants, ${fam.variantsPositiveOnTest} positive on the test period)`);
  L.push(`chosen on the tuning period: ${show(c.variant)}`);
  L.push(`  tuning: $${f(c.train.pnlPerHourUsd, 3)}/h, ${c.train.txs} txs, ${c.train.fills} fills, win ${pct(c.train.winRate)}, ${f(c.train.avgNetBps)} bps avg, gas $${f(c.train.gasUsd, 3)}, drawdown $${f(c.train.maxDrawdownUsd, 3)}`);
  L.push(`  TEST:   $${f(c.test.pnlPerHourUsd, 3)}/h, ${c.test.txs} txs, ${c.test.fills} fills, win ${pct(c.test.winRate)}, ${f(c.test.avgNetBps)} bps avg, gas $${f(c.test.gasUsd, 3)}, drawdown $${f(c.test.maxDrawdownUsd, 3)}`);
  L.push("  next best on the tuning period (tuning -> test, $/h):");
  for (const r of fam.top.slice(1)) L.push(`    ${f(r.train.pnlPerHourUsd, 3)} -> ${f(r.test.pnlPerHourUsd, 3)}  ${show(r.variant)}`);
}
L.push("", `(${report.seconds} s)`);
await out(report, L.join("\n"));
