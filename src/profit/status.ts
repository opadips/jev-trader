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
export function renderStatus(o: { report: any; health: any; deploy: any; backtest?: any; now: Date }): string {
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

  L.push("## Phase 1 gates (last 72 h)", "");
  if (!r || r.note) L.push(r?.note ?? "No report yet: the analyzer needs at least a few minutes of recording.", "");
  else {
    L.push(`Judged only after ${MIN_HOURS} h of recording. A pass has to repeat on separate days before it counts.`, "");
    L.push("| Gate | State | Numbers |", "|---|---|---|");
    for (const g of gates(r)) L.push(`| ${g.name} | ${ICON[g.state]} | ${g.detail} |`);
    L.push("");
    const m = r.market;
    L.push("## Market (last 72 h)", "");
    L.push(`Spread p50 ${f(m.spreadBps?.p50)} bps, ${f(m.printsPerHour, 0)} prints/h, $${f(m.usdPerHour, 0)}/h volume, ${m.distinctTakers} takers, ${m.distinctMakers} makers. Fees: taker ${f(r.costs.takerFeeBps)} bps, maker ${f(r.costs.makerFeeBps)} bps; gas ${f(r.costs.gasBpsPerTx)} bps per tx.`, "");
    const ll = r.leadLag;
    if (ll?.best) L.push(`Kuru follows the reference venues ${ll.best.lag} rows later (corr ${f(ll.best.corr, 3)}); absorbed after 10 rows: ${f(ll.catchUp?.find((x: any) => x.rows === 10)?.beta)}.`, "");
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

  L.push("## Files", "");
  L.push("- `report.txt`: the full analyzer report", "- `report.json`: the same, machine-readable", "- `health.json`: raw recorder health", "- `deploy.json`: last deploy", "- `recorder.log`: last 300 lines of the recorder log", "- `service.txt`: systemd status of the recorder and the agent timer", "- `backtest.txt` / `backtest.json`: the backtest report", "");
  return L.join("\n");
}

if (import.meta.main) {
  const { values: a } = parseArgs({ options: { report: { type: "string" }, health: { type: "string" }, deploy: { type: "string" }, backtest: { type: "string" } } });
  const read = async (p?: string) => { if (!p) return null; try { return JSON.parse(await Bun.file(p).text()); } catch { return null; } };
  const [report, health, deploy, backtest] = await Promise.all([read(a.report), read(a.health), read(a.deploy), read(a.backtest)]);
  process.stdout.write(renderStatus({ report, health, deploy, backtest, now: new Date() }));
}
