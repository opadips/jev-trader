# Progress

The project log for Profit Mode. Updated at the end of every work session. Live numbers are in the
reports repo (`opadips/jev-trader-reports`, README), refreshed hourly by the server.

**Last updated:** 2026-09-25

## Where we are

**Phase 0 (record): recording on the VPS.** The first 7.5 minutes of real data are in (numbers
below; far too little to conclude anything). Nothing trades; no money is at risk.

| Phase | Status | Gate |
|---|---|---|
| 0. Record | 🟢 recording on the VPS since 2026-09-25 00:45 UTC | >90% of blocks recorded, a reference venue live |
| 1. Research | 🟡 analyzer built, needs 1 to 2 weeks of data | an edge that clears costs on separate days |
| 2. Backtest | ⚪ not started | positive on days not used for tuning |
| 3. Paper trade | ⚪ not started | matches the backtest for 2+ weeks |
| 4. Small live | ⚪ not started, budget not decided | positive and in line with paper for weeks |

## Waiting on you

- [x] `vps` branch created (2026-09-25); the server deploys from it.
- [ ] Decide whether to merge Profit Mode into `main` (a pull request), or keep it on its own branches for now.
- [x] Reports repo created and the server set up (2026-09-25).
- [ ] On the server, set `JEV_EVERY=50` in `~/jev-trader/.env` (it still says 10, which overrides
      the new default), then `systemctl --user restart jev-recorder`.
- [ ] Rotate the TypeSafe API key that was pasted in chat; put the new one only in the server's `.env`.
- [ ] Optional: install the TypeSafe skill (`claude plugin marketplace add typesafe-ai/skills`, then
      `claude plugin install typesafe@typesafe-ai`); the cloud session's permission guard blocked it.

## Next

1. **Now to +24 h:** build the backtester (Phase 2 tool): replays the recording, simulates a strategy
   with order size, queue position, one block of latency and gas. Test it on synthetic data, then
   on the first real day.
2. **+24 h:** first real review: gates on the status page, findings written up here.
3. **Days 2 to 14:** keep recording; backtest "take the lag" and "quote around the reference price"
   (Jev as an optional filter) day by day, tuning only on older days.
4. **~Day 14:** verdict per strategy. If one survives: the paper trader (Phase 3). If none: stop.

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

- **2026-09-25** Server live: the agent deployed `2cfdac0` and pushed its first report. The recorder
  could not start until `data/` existed (systemd opens a `StandardOutput=append:` file before any
  command runs, and a clean clone has no `data/`); it started seconds later, once the agent created
  that folder, but the first report was taken before that. Fixed in `064c772` (redirect inside the
  start command), plus: "no recording yet" instead of an analyzer crash, `service.txt` in reports,
  timestamps in the recorder log.
- **2026-09-25** Two agent fixes after the `064c772` deploy produced a report mid-restart: after a
  deploy the agent now waits up to 90 s for the recorder's health and hands over to the newly
  deployed version of itself for the report. Reference venues that push every price change now
  count as current while their connection is alive (a quiet book is not a stale one); venue
  "live" in the reports uses the same rule.

- **2026-09-25** Jev cost cut ~13x: prompt v2 sends summaries instead of raw trade and price-level
  lists and a shorter question (request 2,394 -> 876 characters, ~1,500 -> ~550 tokens), and the
  default is one forecast every 50 blocks instead of 10. Forecasts are stored as `jev-latest@v2`;
  the analyzer scores only the newest version, so v1 and v2 are never mixed.

## Decisions

| Date | Decision | By |
|---|---|---|
| 2026-09-24 | Keep the demo as is; build Profit Mode separately in `src/profit/` | you |
| 2026-09-24 | No real money until it proves itself on paper; budget decided after that | you |
| 2026-09-24 | Research before strategy: measure the edges (making, taking the lag, Jev) with real data first | agreed |
| 2026-09-25 | Work from cloud sessions; the VPS is reached only through GitHub (no SSH from the cloud) | you |
| 2026-09-25 | Server deploys only from the `vps` branch, only if `bun test` passes | you |
| 2026-09-25 | Build the backtester now, while data accumulates; test "take the lag" and "quote around the reference price", with Jev as an optional filter | you |

## First look (2026-09-25, 7.5 minutes of data: anecdotes, not evidence)

- Kuru's MON-USDC fees read from the contract: **0 bps taker, 0 bps maker**. Gas is the only cost.
- Busier than assumed: ~3,500 prints and ~$700k per hour, 16 takers but only 4 makers; median
  spread 4.4 bps (about 11 ticks, so there is room to quote inside); ~19,800 MON at the best level.
- Resting orders at the touch roughly broke even before gas (half-spread 1.9 bps, then ~1.5 to 2 bps
  of adverse move). Gas is 1.8 bps per order, so plain touch-quoting looks unprofitable so far.
- **Kuru follows Bybit and OKX**: correlation peaks one block later (0.27), and Kuru has absorbed
  ~49% of a reference move after 3 blocks and ~73% after 10. This is the most promising lead.
- Jev: 212 ms median latency, no errors, ~$0.08 an hour at first (~1,500 input tokens per call,
  1,200 calls an hour). Cut ~13x on 2026-09-25 (prompt v2, below). Its test sample (57 forecasts,
  one 3-minute downtrend) says nothing yet.
- Binance never quoted MON (probably not listed there); Coinbase's feed is trade-driven and sparse.

## Open questions and known issues

- Which exchanges list MON (and under which symbol) is unknown until the recorder runs; silent
  venues show on the status page.
- Kuru's real fees are read from the contract at startup and shown in the report.
- Demo Mode still sends the stale Jev prompt; left untouched on purpose (Demo Mode is out of scope).
