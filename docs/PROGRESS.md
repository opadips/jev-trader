# Progress

The project log for Profit Mode. Updated at the end of every work session. Live numbers are in the
reports repo (`opadips/jev-trader-reports`, README), refreshed hourly by the server.

**Last updated:** 2026-09-26

## Where we are

**Day 1 of ~14: recording cleanly, first real numbers in (below).** On day 1 nothing we tested
makes money after costs; the one faint lead is taking very large gaps (20+ bps) with big orders.
Nothing trades; no money is at risk.

| Phase | Status | Gate |
|---|---|---|
| 0. Record | 🟢 recording on the VPS since 2026-09-25 00:45 UTC | >90% of blocks recorded, a reference venue live |
| 1. Research | 🟡 day 1 done: only faint lead is big-gap lag taking; needs more days | an edge that clears costs on separate days |
| 2. Backtest | 🟡 backtester built and running hourly on the server; needs days of data | positive on days not used for tuning |
| 3. Paper trade | ⚪ not started | matches the backtest for 2+ weeks |
| 4. Small live | ⚪ not started, budget not decided | positive and in line with paper for weeks |

## Waiting on you

- [x] `vps` branch created (2026-09-25); the server deploys from it.
- [ ] Decide whether to merge Profit Mode into `main` (a pull request), or keep it on its own branches for now.
- [x] Reports repo created and the server set up (2026-09-25).
- [x] `JEV_EVERY=50` set in the server's `.env` (2026-09-25).
- [ ] Rotate the TypeSafe API key that was pasted in chat; put the new one only in the server's `.env`.
- [ ] Optional: install the TypeSafe skill (`claude plugin marketplace add typesafe-ai/skills`, then
      `claude plugin install typesafe@typesafe-ai`); the cloud session's permission guard blocked it.

## Next

1. Read the widened backtest (large gaps, large sizes; wider and calmer quoting) and the memory
   numbers (the service showed 443 of 512 MB; the new health fields tell a leak from file cache).
2. Decide Jev's role (needs you): change the question (e.g. a 3 s horizon, or "is it safe to
   quote now") or pause it. It costs $0.16 a day, so there is no rush.
3. **Days 2 to 14:** keep recording; check day by day whether the big-gap lag trade repeats.
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

- **2026-09-25** Backtester (Phase 2 tool): `bun run backtest` replays the recording with one block
  of latency, gas on every transaction, taker orders walking the recorded levels, and resting
  orders queuing by price and time behind the recorded size. Two strategies over grids: "take the
  lag" (with and without a Jev filter) and "quote around a fair price" (reference price vs Kuru's
  own mid). Settings picked on the first 60% of the window, reported on the last 40%. Runs hourly
  on the server; results on the status page. 8 new tests with hand-checked queue scenarios.

- **2026-09-26** Day 1 review (above). Backtest grids widened: lag taking now tries gaps of 5 to
  30 bps, sizes up to 10,000 MON and holds of 3 to 33 blocks; quoting tries 2 to 12 bps from fair
  value and re-quote thresholds up to 8 bps. Recorder health reports its own memory (resident and
  heap), to tell a leak apart from the reclaimable file cache systemd also counts.

## Decisions

| Date | Decision | By |
|---|---|---|
| 2026-09-24 | Keep the demo as is; build Profit Mode separately in `src/profit/` | you |
| 2026-09-24 | No real money until it proves itself on paper; budget decided after that | you |
| 2026-09-24 | Research before strategy: measure the edges (making, taking the lag, Jev) with real data first | agreed |
| 2026-09-25 | Work from cloud sessions; the VPS is reached only through GitHub (no SSH from the cloud) | you |
| 2026-09-25 | Server deploys only from the `vps` branch, only if `bun test` passes | you |
| 2026-09-25 | Build the backtester now, while data accumulates; test "take the lag" and "quote around the reference price", with Jev as an optional filter | you |

## Day 1 review (2026-09-26, 24.3 h of data)

**Recording:** 94% of blocks (the rest are single blocks skipped when heads arrive in bursts),
Bybit and OKX fresh 99.7%+, no read errors, no restarts since the `JEV_EVERY` change. Jev: 5,186
forecasts, 6 errors, 227 ms average, **$0.16 for the day** (~720 tokens a call, every 50 blocks).

**Market:** median spread 3.9 bps; ~2,400 prints and ~$630k an hour; 44 takers, 10 makers; median
print 7,566 MON (bigger than we assumed); ~19,400 MON at the best price.

**1. Resting orders lose even before gas.** Makers earned 2.46 bps of spread per fill but lost
2.8 to 3.0 bps as the price moved against them: net about -0.3 to -0.5 bps per fill before any
gas. The median fill is positive (+0.8 bps), so the loss comes from occasional large moves:
someone informed trades against the book. The backtest agrees: every quoting variant lost on
the unseen 9.5 h, and quoting around the reference price did barely better than around Kuru's
own mid (-$0.64/h vs -$0.67/h), so the reference does not rescue it as built.

**2. Kuru does follow Bybit/OKX, but only partly.** Correlation peaks one block later (0.32);
Kuru absorbs 41% of a reference move in 1 block, 62% in 3, then levels off near 70%.

**3. Taking the lag pays only on big gaps.** Buying/selling a block late and marking 10 s later:
gaps over 10 bps break even (+0.75 bps, 82 trades), gaps over 20 bps made +9.5 bps each
(19 trades in 24 h, 63% winners). Too few to trust, and the backtest's grid stopped at 8 bps and
5,000 MON, so it never tested this. Widened on 2026-09-26 (up to 30 bps and 10,000 MON; gas per
transaction is fixed, so bigger orders pay far less of it per dollar).

**4. Jev v2 has no forecasting skill on this question.** On 2,192 held-out forecasts it was right
33% of the time, while always guessing the most common outcome ("flat") is right 47%; its log
loss (1.55) is worse than the plain base rate (1.06), and following its lean lost money at every
confidence level. The simple statistical baseline did no better than the base rate either: the
30-second direction looks close to unpredictable from these inputs. Jev does not earn a role as a
30 s forecaster.

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

## First backtest (2026-09-25 01:41 UTC, 0.9 h of data: a smoke test, not evidence)

- Both strategies lost money on the unseen 0.4 h at every setting tried, bar 1 of 102 variants.
- Quoting around the reference price: ~1,300 re-quotes an hour, and gas (~3.7 bps per fill) is what
  sinks it; before gas its fills roughly broke even. Next grid should try far fewer re-quotes
  (wider thresholds) and wider quotes, once there is a day of data.
- Taking the lag: only the 8 bps threshold traded at all, a handful of times, all losing.
- Jev v2 on 42 scored forecasts: poorly calibrated so far (log loss 1.88 vs 1.15 for simply
  guessing the usual mix), i.e. confident and often wrong. Far too few to judge.
- Venue freshness after the fix: Bybit 96%, OKX 93%. Jev v2 costs ~720 tokens per call (was
  ~1,500); the server still calls every 10 blocks until `JEV_EVERY=50` is set in its `.env`.

## Open questions and known issues

- Which exchanges list MON (and under which symbol) is unknown until the recorder runs; silent
  venues show on the status page.
- Kuru's real fees are read from the contract at startup and shown in the report.
- Demo Mode still sends the stale Jev prompt; left untouched on purpose (Demo Mode is out of scope).
