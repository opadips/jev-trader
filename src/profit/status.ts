/**
 * The live status page: turns the analyzer's JSON, the recorder's /health and the last deploy into
 * a README.md for the reports repo, including an automatic check of each Phase 1 gate
 * (docs/PROFIT.md). The VPS agent runs this hourly and pushes the result.
 *
 *   bun run src/profit/status.ts --report report.json --health health.json --deploy deploy.json > README.md
 */
import { parseArgs } from "node:util";

export type GateState = "pass" | "fail" | "collecting" | "no data";
export interface Gate { name: string; state: GateState; detail: string }

/** Spread p90 above which a market's book counts as degenerate in the cross-market tables. */
export const DEGENERATE_SPREAD_BPS = 100;

/** Minimum recording before a gate is judged at all. */
export const MIN_HOURS = 24;

const f = (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

/** The Phase 1 gates from docs/PROFIT.md, judged on one report. A pass still has to hold on separate days. */
export function gates(r: any): Gate[] {
  const hours: number = r?.coverage?.hours ?? 0;
  const early = hours < MIN_HOURS;
  const judged = (ok: boolean): GateState => (early ? "collecting" : ok ? "pass" : "fail");
  const out: Gate[] = [];

  const cov = r?.coverage;
  const bestVenue = Math.max(0, ...Object.values<number>(cov?.venueFresh ?? {}));
  out.push({
    name: "Clean recording",
    state: cov ? judged(cov.blockCoverage > 0.9 && bestVenue > 0.8) : "no data",
    detail: cov ? `${f(hours, 1)} h, ${pct(cov.blockCoverage)} of blocks, best reference venue live ${pct(bestVenue)}` : "no report yet",
  });

  const gas: number = r?.costs?.gasBpsPerTx ?? NaN;
  const m33 = (r?.makerMarkouts ?? []).find((m: any) => m.horizon === 33);
  out.push({
    name: "Making pays (maker net at 33 blocks > 2x gas per quote)",
    state: m33 && Number.isFinite(m33.netBps) ? judged(m33.netBps > 2 * gas) : early ? "collecting" : "no data",
    detail: m33 ? `net ${f(m33.netBps)} bps vs 2 x gas ${f(2 * gas)} bps (n=${m33.n})` : "no prints yet",
  });

  const arbs: any[] = r?.takerArb ?? [];
  const winner = arbs.find((a) => a.netBps > 0 && a.hitRate > 0.55 && a.perHour >= 1);
  const bestArb = [...arbs].filter((a) => Number.isFinite(a.netBps)).sort((a, b) => b.netBps - a.netBps)[0];
  out.push({
    name: "Taking the lag pays (net > 0, win > 55%, 1+ trade/h)",
    state: arbs.length && bestArb ? judged(!!winner) : early ? "collecting" : "no data",
    detail: winner
      ? `edge > ${winner.thresholdBps} bps: net ${f(winner.netBps)} bps, win ${pct(winner.hitRate)}, ${f(winner.perHour, 1)}/h`
      : bestArb ? `best: edge > ${bestArb.thresholdBps} bps, net ${f(bestArb.netBps)} bps, win ${pct(bestArb.hitRate)}, ${f(bestArb.perHour, 1)}/h` : "no reference data yet",
  });

  const fc = r?.forecasts, models = fc?.models;
  if (!models?.jev) {
    out.push({ name: "Jev beats the baselines", state: early || fc?.note ? "collecting" : "no data", detail: fc?.note ?? "no forecasts yet" });
  } else {
    const others = Object.entries<any>(models).filter(([k]) => k !== "jev").map(([, s]) => s.logLoss as number);
    const beatsLL = models.jev.logLoss < Math.min(...others);
    const d = models.jev.directional.find((x: any) => x.threshold === 0.2);
    const roundTrip = (r?.market?.spreadBps?.p50 ?? NaN) + 2 * ((r?.costs?.takerFeeBps || 0) + gas);
    const beatsCost = d && d.meanSignedBps > roundTrip;
    out.push({
      name: "Jev beats the baselines (log loss, and its lean beats a taker round trip)",
      state: judged(beatsLL && !!beatsCost),
      detail: `log loss ${f(models.jev.logLoss, 3)} vs best baseline ${f(Math.min(...others), 3)}; lean > 0.2 moves ${f(d?.meanSignedBps)} bps (n=${d?.n ?? 0}) vs round trip ${f(roundTrip)} bps`,
    });
  }
  return out;
}

const ICON: Record<GateState, string> = { pass: "✅ pass", fail: "❌ fail", collecting: "⏳ collecting", "no data": "⚪ no data" };

/** README.md for the reports repo. */
/** One finished day's stored analysis and backtest (days/<day>.report.json and .backtest.json). */
export interface DayResult { day: string; report: any; backtest: any }

/** The day-by-day table: the numbers that decide whether anything repeats. */
export function renderDays(days: DayResult[]): string[] {
  if (!days.length) return ["No finished days analyzed yet.", ""];
  const f = (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/a");
  const L = ["| Day | Hours | Lead (corr, +1 block) | Resting order net at 33 blocks | Gaps > 20 bps: trades, net bps | Best lag-taking on unseen $/h | Best quoting on unseen $/h | Jev vs lead (log loss) |", "|---|---|---|---|---|---|---|---|"];
  for (const { day, report: r, backtest: b } of days) {
    const m33 = r?.makerMarkouts?.find((m: any) => m.horizon === 33);
    const g20 = r?.takerArb?.find((a: any) => a.thresholdBps === 20);
    const best = (name: string) => {
      const fam = b?.families?.find((x: any) => x.name === name);
      const vals: number[] = (fam?.all ?? []).map((v: any) => v[2]).filter((x: any) => typeof x === "number");
      return vals.length ? Math.max(...vals) : NaN;
    };
    const models = r?.forecasts?.models;
    const jev = models?.jev ? `${f(models.jev.logLoss, 3)} vs ${f(models.lead?.logLoss, 3)}` : "n/a";
    L.push(`| ${day} | ${f(r?.coverage?.hours, 1)} | ${f(r?.leadLag?.best?.corr, 3)} | ${f(m33?.netBps)} | ${g20 ? `${g20.trades}, ${f(g20.netBps)}` : "n/a"} | ${f(best("take the lag"), 3)} | ${f(best("quote around a fair price"), 3)} | ${jev} |`);
  }
  L.push("", "Each day is analyzed on its own (backtests tuned on its first 60%, scored on its last 40%). \"Best on unseen\" is the best of all settings on the unseen part, so it flatters; a real edge shows up as the same settings winning day after day.", "");
  return L;
}

/** One recorded market's latest 24 h analysis and backtest. */
export interface MarketResult { name: string; report: any; backtest: any }

/**
 * The cross-market comparison: the same baseline measurements for every market, no per-market
 * tuning. Edge figures are the taker check (enter a block late at the touch, exit 33 blocks later
 * at the touch, gas and fees on both legs, on a $5 order) and the backtests' unseen part.
 */
export function renderCompare(markets: MarketResult[]): string[] {
  // A book with a dust order on one side has an absurd mid; its gap and resting-order figures are artifacts.
  const degenerate = (r: any) => (r?.market?.spreadBps?.p90 ?? 0) > DEGENERATE_SPREAD_BPS;
  const ok = markets.filter((m) => m.report && !m.report.note).map((m) => (degenerate(m.report) ? { ...m, name: `${m.name} ⚠️` } : m));
  if (!ok.length) return ["No market has enough data yet.", ""];
  const f = (x: unknown, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "n/a");
  const k = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : x.toFixed(0)) : "n/a");
  const arb = (r: any, th: number) => r.takerArb?.find((a: any) => a.thresholdBps === th);
  const win = (a: any) => (typeof a?.hitRate === "number" && Number.isFinite(a.hitRate) && a.trades ? `${(a.hitRate * 100).toFixed(0)}%` : "n/a");
  const L = [
    "**Activity and costs**", "",
    "| Market | Volume $/h | Trades/h | Median spread bps (p10 / p90) | Touch $ | Depth ±10 bps $ | Reference fresh | Lag blocks (corr) | Absorbed after 1 / 3 / 5 / 10 / 20 blocks | Gas per tx ($, bps on $5) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { name, report: r } of ok) {
    const m = r.market, ll = r.leadLag;
    const fresh = Math.max(0, ...Object.values<number>(r.coverage?.venueFresh ?? {}));
    const abs = [1, 3, 5, 10, 20].map((h) => { const c = ll?.catchUp?.find((x: any) => x.afterBlocks === h); return c ? `${f(c.beta)}${c.blocks > h ? `@${c.blocks}` : ""}` : "n/a"; }).join(" / ");
    L.push(`| ${name} | ${k(m.usdPerHour)} | ${f(m.printsPerHour, 0)} | ${f(m.spreadBps?.p50)} (${f(m.spreadBps?.p10)} / ${f(m.spreadBps?.p90)}) | ${k(((m.touchMon?.bid ?? 0) + (m.touchMon?.ask ?? 0)) * m.medianMid)} | ${k(m.depthQuote?.["10"])} | ${(fresh * 100).toFixed(0)}% | ${f(ll?.best?.lagBlocks, 0)} (${f(ll?.best?.corr, 3)}) | ${abs} | ${f(r.costs?.gasUsdPerTx, 4)}, ${f(r.costs?.gasBpsPerTx)} |`);
  }
  L.push("", "**Edge**", "",
    "| Market | Gaps > 10 / > 20 bps per h | Gross edge > 20 bps (bps) | Net edge > 10 / > 20 bps (bps, win) | Resting order at 33 blocks: capture - adverse = net (before gas) | Lag taking, best unseen $/h at $5 / $50 / $250 | Unseen: chosen lag / quote $/h (variants positive) |",
    "|---|---|---|---|---|---|---|");
  for (const { name, report: r, backtest: b } of ok) {
    const a10 = arb(r, 10), a20 = arb(r, 20);
    const m33 = r.makerMarkouts?.find((x: any) => x.horizon === 33);
    const lag = b?.families?.find((x: any) => x.name === "take the lag"), quote = b?.families?.find((x: any) => x.name === "quote around a fair price");
    const bestAt = (usd: number) => { const v = (lag?.all ?? []).filter((x: any) => x[0]?.sizeUsd === usd).map((x: any) => x[2]).filter((x: any) => typeof x === "number"); return v.length ? f(Math.max(...v), 3) : "n/a"; };
    const pos = (fam: any) => (fam ? `${fam.variantsPositiveOnTest}/${fam.variants}` : "n/a");
    L.push(`| ${name} | ${f(a10?.perHour, 1)} / ${f(a20?.perHour, 1)} | ${f(a20?.grossBps)} | ${f(a10?.netBps)} (${win(a10)}) / ${f(a20?.netBps)} (${win(a20)}) | ${f(m33?.captureBps)} - ${f(m33?.adverseBps)} = ${f(m33?.netBps)} | ${bestAt(5)} / ${bestAt(50)} / ${bestAt(250)} | ${f(lag?.chosen?.test?.pnlPerHourUsd, 3)} (${pos(lag)}) / ${f(quote?.chosen?.test?.pnlPerHourUsd, 3)} (${pos(quote)}) |`);
  }
  for (const { name, report: r } of ok) {
    if (degenerate(r)) L.push("", `⚠️ ${name.replace(" ⚠️", "")}: its spread p90 is ${f(r.market.spreadBps.p90, 0)} bps (one side of the book is dust), so its price, gap and resting-order figures are artifacts, not edge.`);
  }
  L.push("", "Same baseline for every market, no per-market tuning. \"Best unseen\" is the best of all settings on the unseen part, so it flatters; \"chosen\" is the setting picked on the tuning part, scored on the unseen part. Books of the extra markets are read every 2 blocks, so their 1-block figures are measured at 2 blocks (\"@2\") and their taker entries land 2 blocks late, never earlier than on the control. A market is only interesting if its net edge is positive and repeats day after day.", "");
  return L;
}

/** One line per extra market from the markets recorder's /health. */
export function renderMarketsHealth(h: any): string[] {
  if (!h) return ["⚠️ **Markets recorder: no health response** (see `service.txt`).", ""];
  const L = [`${h.ok ? "🟢" : "🔴"} Markets recorder: up ${f((h.uptimeS ?? 0) / 3600, 1)} h, book every ${h.sampleEvery} blocks, ${h.stats?.samples ?? 0} samples, ${h.stats?.skipped ?? 0} skipped, ${h.stats?.requestErrors ?? 0} request errors, ${h.stats?.logErrors ?? 0} log errors.`, ""];
  L.push("| Market | Rows | Trades | Read errors | Last book | Spread bps | Reference live |", "|---|---|---|---|---|---|---|");
  for (const m of h.markets ?? []) {
    const live = (m.venues ?? []).filter((v: any) => v.live).map((v: any) => v.venue).join(", ") || "none";
    L.push(`| ${m.pair} | ${m.rows} | ${m.prints} | ${m.readErrors} | ${m.lastBookAgeMs === null ? "never" : `${(m.lastBookAgeMs / 1000).toFixed(1)} s ago`} | ${m.lastSpreadBps ?? "n/a"} | ${live} |`);
  }
  L.push("");
  return L;
}

export function renderStatus(o: { report: any; health: any; deploy: any; backtest?: any; days?: DayResult[]; markets?: MarketResult[]; marketsHealth?: any; agent?: string | null; now: Date }): string {
  const { report: r, health: h, deploy: d, backtest: bt, now } = o;
  const L: string[] = [];
  L.push("# Jev Trader: live status", "");
  L.push(`Updated ${now.toISOString().replace("T", " ").slice(0, 16)} UTC by the VPS agent. Phase: **0 (recording) / 1 (research)**. Plan and gates: docs/PROFIT.md in the code repo.`, "");

  L.push("## Recorder", "");
  if (!h) L.push("⚠️ **No health response**: the recorder is not running or not answering. See `service.txt` (what systemd says) and `recorder.log`.", "");
  else {
    L.push(`${h.ok ? "🟢 **Recording**" : "🔴 **Stale**"}: block ${h.lastBlock ?? "n/a"}, last book ${h.lastBookAgeMs ?? "n/a"} ms ago, up ${f((h.uptimeS ?? 0) / 3600, 1)} h, mid ${h.lastMid ?? "n/a"}, spread ${h.lastSpreadBps ?? "n/a"} bps.`, "");
    const s = h.stats ?? {};
    if (h.mem) L.push(`Memory: ${h.mem.rssMb} MB resident, ${h.mem.heapUsedMb} MB heap (limit 512 MB for the service, which also counts reclaimable file cache).`, "");
    L.push(`Rows ${s.recorded ?? 0}, skipped ${s.skipped ?? 0}, read errors ${s.readErrors ?? 0}, prints ${s.prints ?? 0}. Jev: ${s.jevCalls ?? 0} forecasts, ${s.jevErrors ?? 0} errors, ${s.jevAvgLatencyMs ?? "n/a"} ms average, $${s.jevUsd ?? 0} spent since start.`, "");
    L.push("| Venue | Symbol | State | Last price change |", "|---|---|---|---|");
    for (const v of h.venues ?? []) {
      const live = v.live ?? (v.lastQuoteAgeMs !== null && v.lastQuoteAgeMs < 5000);
      L.push(`| ${v.venue} | ${v.symbol} | ${live ? "live" : v.connected ? "connected, no quotes" : "down"}${v.lastError ? ` (${v.lastError})` : ""} | ${v.lastQuoteAgeMs === null ? "never" : `${Math.round(v.lastQuoteAgeMs / 1000)} s ago`} |`);
    }
    L.push("");
  }

  L.push("## Deploy", "");
  if (!d) L.push("No deploy record yet.", "");
  else L.push(`Running \`${String(d.commit ?? "").slice(0, 7)}\` from \`${d.branch}\`, deployed ${d.deployedAt ?? "n/a"}. Last check ${d.checkedAt ?? "n/a"}: **${d.result ?? "n/a"}**${d.detail ? `: ${d.detail}` : ""}.`, "");

  L.push("## Phase 1 gates (last 24 h)", "");
  if (!r || r.note) L.push(r?.note ?? "No report yet: the analyzer needs at least a few minutes of recording.", "");
  else {
    L.push(`Judged only after ${MIN_HOURS} h of recording. A pass has to repeat on separate days before it counts.`, "");
    L.push("| Gate | State | Numbers |", "|---|---|---|");
    for (const g of gates(r)) L.push(`| ${g.name} | ${ICON[g.state]} | ${g.detail} |`);
    L.push("");
    const m = r.market;
    L.push("## Market (last 24 h)", "");
    L.push(`Spread p50 ${f(m.spreadBps?.p50)} bps, ${f(m.printsPerHour, 0)} prints/h, $${f(m.usdPerHour, 0)}/h volume, ${m.distinctTakers} takers, ${m.distinctMakers} makers. Fees: taker ${f(r.costs.takerFeeBps)} bps, maker ${f(r.costs.makerFeeBps)} bps; gas ${f(r.costs.gasBpsPerTx)} bps per tx.`, "");
    const ll = r.leadLag;
    if (ll?.best) L.push(`Kuru follows the reference venues ${f(ll.best.lagBlocks ?? ll.best.lag, 0)} blocks later (corr ${f(ll.best.corr, 3)}); absorbed after 10 blocks: ${f(ll.catchUp?.find((x: any) => x.afterBlocks === 10)?.beta)}.`, "");
  }

  L.push("## Backtest (Phase 2 tool, last 24 h)", "");
  if (!bt) L.push("No backtest yet.", "");
  else if (bt.note) L.push(bt.note, "");
  else {
    L.push(`Each strategy's settings are picked on the first ${f(bt.hours?.train, 1)} h, then scored on the last ${f(bt.hours?.test, 1)} h they never saw. Costs: ${bt.costs?.latencyBlocks} block latency, ${bt.costs?.gasMon} MON gas per transaction. A result only counts once it holds on several separate days.`, "");
    L.push("| Strategy | Chosen settings | Tuning $/h | **Unseen $/h** | Unseen trades | Variants positive on unseen |", "|---|---|---|---|---|---|");
    for (const fam of bt.families ?? []) {
      const v = Object.entries(fam.chosen.variant).map(([k, x]) => `${k}=${x}`).join(", ");
      L.push(`| ${fam.name} | ${v} | ${f(fam.chosen.train.pnlPerHourUsd, 3)} | **${f(fam.chosen.test.pnlPerHourUsd, 3)}** | ${fam.chosen.test.txs} txs, ${fam.chosen.test.fills} fills | ${fam.variantsPositiveOnTest} of ${fam.variants} |`);
    }
    L.push("");
  }

  if (o.markets?.length) {
    L.push("## Cross-market comparison (last 24 h)", "");
    L.push(...renderMarketsHealth(o.marketsHealth));
    L.push(...renderCompare(o.markets));
  }

  L.push("## Day by day (finished UTC days)", "");
  L.push(...renderDays(o.days ?? []));

  if (o.agent) L.push("## Server (agent run)", "", "```", o.agent.trim(), "```", "");

  L.push("## Files", "");
  L.push("- `report.txt`: the full analyzer report", "- `report.json`: the same, machine-readable", "- `health.json`: raw recorder health", "- `deploy.json`: last deploy", "- `recorder.log`: last 300 lines of the recorder log", "- `service.txt`: systemd status of the recorder and the agent timer", "- `backtest.txt` / `backtest.json`: the backtest report", "- `days/`: each finished day's analysis and backtest (`days/<market>/` for the extra markets)", "- `markets/`: the extra markets' last 24 h analysis and backtest", "- `markets-health.json`: raw health of the extra markets' recorder", "- `survey.txt` / `survey.json`: which Kuru markets trade, refreshed daily", "- `agent.txt`: the last agent run (disk, step timings, errors)", "");
  return L.join("\n");
}

if (import.meta.main) {
  const { values: a } = parseArgs({ options: { report: { type: "string" }, health: { type: "string" }, deploy: { type: "string" }, backtest: { type: "string" }, "days-dir": { type: "string" }, "markets-dir": { type: "string" }, "markets-health": { type: "string" }, agent: { type: "string" } } });
  const read = async (p?: string) => { if (!p) return null; try { return JSON.parse(await Bun.file(p).text()); } catch { return null; } };
  const [report, health, deploy, backtest] = await Promise.all([read(a.report), read(a.health), read(a.deploy), read(a.backtest)]);
  const days: DayResult[] = [];
  if (a["days-dir"]) {
    const names = [...new Bun.Glob("*.report.json").scanSync(a["days-dir"])].sort();
    for (const n of names) {
      const day = n.replace(".report.json", "");
      days.push({ day, report: await read(`${a["days-dir"]}/${n}`), backtest: await read(`${a["days-dir"]}/${day}.backtest.json`) });
    }
  }
  const agent = a.agent && (await Bun.file(a.agent).exists()) ? await Bun.file(a.agent).text() : null;
  // the control market first, then each extra market (markets/<slug>.report.json and .backtest.json)
  const markets: MarketResult[] = [];
  if (a["markets-dir"]) {
    markets.push({ name: "MON/USDC (control)", report, backtest });
    for (const n of [...new Bun.Glob("*.report.json").scanSync(a["markets-dir"])].sort()) {
      const slug = n.replace(".report.json", "");
      const r = await read(`${a["markets-dir"]}/${n}`);
      markets.push({ name: r?.pair ?? slug, report: r, backtest: await read(`${a["markets-dir"]}/${slug}.backtest.json`) });
    }
  }
  process.stdout.write(renderStatus({ report, health, deploy, backtest, days, markets, marketsHealth: await read(a["markets-health"]), agent, now: new Date() }));
}
