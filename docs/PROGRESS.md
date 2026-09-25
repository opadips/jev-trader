# Progress

The project log for Profit Mode. Updated at the end of every work session. Live numbers are in the
reports repo (`opadips/jev-trader-reports`, README), refreshed hourly by the server.

**Last updated:** 2026-09-25

## Where we are

**Phase 0 (record): built and rehearsed, waiting on the server.** Nothing has been recorded from the
real market yet. Nothing trades; no money is at risk.

| Phase | Status | Gate |
|---|---|---|
| 0. Record | 🟡 built, not yet running on the VPS | >90% of blocks recorded, a reference venue live |
| 1. Research | 🟡 analyzer built, needs 1 to 2 weeks of data | an edge that clears costs on separate days |
| 2. Backtest | ⚪ not started | positive on days not used for tuning |
| 3. Paper trade | ⚪ not started | matches the backtest for 2+ weeks |
| 4. Small live | ⚪ not started, budget not decided | positive and in line with paper for weeks |

## Waiting on you

- [ ] Confirm the cloud session may create and push the `vps` branch (the server deploys from it).
- [ ] Create the private repo `opadips/jev-trader-reports` and follow docs/VPS-SETUP.md.
- [ ] Rotate the TypeSafe API key that was pasted in chat; put the new one only in the server's `.env`.
- [ ] Optional: install the TypeSafe skill (`claude plugin marketplace add typesafe-ai/skills`, then
      `claude plugin install typesafe@typesafe-ai`); the cloud session's permission guard blocked it.

## Next

1. Server up: read the first reports, fix anything the live feeds break (venue symbols, RPC limits).
2. After 24 h: first real look at spread, flow, maker markouts, lead-lag and Jev vs baselines.
3. After 1 to 2 weeks: Phase 1 verdict per edge, written up here. Then the backtester for whichever
   edge passed, or stop if none did.

## Done

- **2026-09-24** Reviewed the demo: well-engineered execution, but it pays ~1.8 bps of gas on every
  block's quote and its Jev prompt still describes an old strategy. Conclusion: keep its execution
  layer, replace the strategy, measure before risking money.
- **2026-09-24** Profit Mode phase 0 (commit `8aefd7f`): recorder (Kuru book, trades, Binance /
  Bybit / OKX / Coinbase quotes, Jev forecasts into SQLite), analyzer (flow, maker markouts,
  lead-lag, taker arbitrage, Jev vs 3 baselines), tests on a synthetic market.
- **2026-09-25** Server bridge: VPS agent (deploy from `vps` with tests as the gate and automatic
  rollback, hourly status push), systemd units, live status page with automatic gate checks,
  setup guide. Rehearsed end to end locally: first report, failed deploy rolled back, good deploy.

## Decisions

| Date | Decision | By |
|---|---|---|
| 2026-09-24 | Keep the demo as is; build Profit Mode separately in `src/profit/` | you |
| 2026-09-24 | No real money until it proves itself on paper; budget decided after that | you |
| 2026-09-24 | Research before strategy: measure the edges (making, taking the lag, Jev) with real data first | agreed |
| 2026-09-25 | Work from cloud sessions; the VPS is reached only through GitHub (no SSH from the cloud) | you |
| 2026-09-25 | Server deploys only from the `vps` branch, only if `bun test` passes | proposed, awaiting OK |

## Open questions and known issues

- Which exchanges list MON (and under which symbol) is unknown until the recorder runs; silent
  venues show on the status page.
- Kuru's real fees are read from the contract at startup and shown in the report.
- Demo Mode still sends the stale Jev prompt; left untouched on purpose (Demo Mode is out of scope).
