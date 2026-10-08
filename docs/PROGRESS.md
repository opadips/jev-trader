# Progress

The project log for Profit Mode. Updated at the end of every work session. Live numbers are in the
reports repo (`opadips/jev-trader-reports`, README), refreshed hourly by the server.

**Last updated:** 2026-10-08

## Where we are

**Day 3 of ~14: recording cleanly; still no strategy that survives realistic costs on MON-USDC.**
The Bybit/OKX lead is real and stable, but trading it did not hold up in the backtest, and Jev's
3-second forecasts do not beat a one-line rule. Now also recording cbBTC/USDC, WETH/USDC and
XAUt0/USDC with the same measurements, to see whether any busy Kuru market has an edge; MON-USDC
continues unchanged as the control. Nothing trades; no money is at risk.

| Phase | Status | Gate |
|---|---|---|
| 0. Record | 🟢 recording on the VPS since 2026-09-25 00:45 UTC | >90% of blocks recorded, a reference venue live |
| 1. Research | 🟡 MON-USDC day 3: lead-lag stable, no strategy survives costs yet; 3 more markets recording from 2026-09-28 | an edge that clears costs on separate days, on unseen data |
| 2. Backtest | 🟡 backtester built and running hourly on the server; needs days of data | positive on days not used for tuning |
| 3. Paper trade | ⚪ not started | matches the backtest for 2+ weeks |
| 4. Small live | ⚪ not started, budget not decided | positive and in line with paper for weeks |

## Waiting on you

- [x] `vps` branch created (2026-09-25); the server deploys from it.
- [x] Retired branch `claude/funny-bohr-xvrfex` deleted on GitHub (2026-09-27).
- [ ] Decide whether to merge Profit Mode into `main` (a pull request), or keep it on its own branches for now.
- [x] Reports repo created and the server set up (2026-09-25).
- [x] `JEV_EVERY=50` set in the server's `.env` (2026-09-25).
- [ ] Rotate the TypeSafe API key that was pasted in chat; put the new one only in the server's `.env`.
- [ ] Optional: install the TypeSafe skill (`claude plugin marketplace add typesafe-ai/skills`, then
      `claude plugin install typesafe@typesafe-ai`); the cloud session's permission guard blocked it.

## Next

0. **Extra markets:** running (confirmed 2026-09-28), storage agreed for up to 10 days (to ~2026-10-08;
   watch "disk" in `agent.txt`). Compare markets day by day once full days exist; no per-market tuning unless an edge repeats on unseen days.
1. Watch the corrected per-day big-gap numbers (analyzer now exits at the touch and pays gas on
   both legs). If they stay positive after that correction on most days, dig into why the
   backtest disagrees (it walks deeper levels with 10,000 MON and exits on catch-up).
2. Jev v3 (frozen: same prompt, inputs, horizon and frequency, MON-USDC only): keep collecting (it costs ~$0.14 a day) and re-score at day 7; unless it beats the
   "lead" rule and the logistic baseline, it gets no role in any strategy.
3. **Days 3 to 14:** keep recording; an early stop is reasonable around day 7 if nothing changes.
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

- **2026-09-26** Jev question v3: Kuru's mid in 10 blocks (~3 s), flat within 2 bps, with the
  other exchanges' 1/3/5/20-block moves and how much of them Kuru has not followed yet. Horizon
  and band now live with the versioned question in code (the `JEV_HORIZON_BLOCKS` / `FLAT_BPS`
  lines in the server's `.env` are ignored and can be deleted). New "lead" baseline in the
  forecast report. Same cost as v2 (~970-character request).

- **2026-09-26** Memory check: the server's heap climbed ~8 MB every 10 minutes (75 -> 134 MB in
  90 min). Soak tests found no leak in any part: the recorder on a fast fake chain (2,000 rows,
  15,000 trades), the exchange price feed (13,000 messages) and the Jev call path (188,000 calls)
  all stay flat after a garbage collection. The climb was most likely uncollected garbage (and the
  earlier 443 MB systemd figure also counts reclaimable file cache). The recorder now collects
  garbage once a minute before measuring, so the reported figure is memory actually kept; if it
  still climbs on the server, the leak is in the real TLS connections, which cannot be tested here.
  The fake RPC gained `FAKE_BLOCK_MS` and `FAKE_LOGS` for soak tests.

- **2026-09-27** Day 2 review (below). Memory closed: no leak. Analyzer fix: the taker-arbitrage
  check now exits at the bid/ask instead of the mid and pays gas and fees on both legs (it had
  been flattering the big-gap result by about half a spread plus one gas); it also shows each UTC
  day separately.

- **2026-09-27** One branch: everything is committed to `vps` directly (the separate working
  branch always pointed at the same tested commit, so it only added noise). The agent now picks up
  documentation-only pushes without running tests or restarting the recorder, so progress-log
  updates cause no gap in recording.

- **2026-09-28** Report stall fixed: every run now pushes a cheap liveness report (health, service
  status, log tail, disk space) before any heavy work; the hourly analysis and backtest cover the
  last 24 h only; each finished UTC day is analysed once and kept in `days/` in the reports repo,
  with a day-by-day table on the status page; every heavy step has its own time limit and its
  timing and errors go to `agent.txt`; an index on `books.ts` stops time-window queries from
  scanning the whole database; the agent's systemd limit is 90 minutes. Backtest JSON now keeps
  every variant's result, not just the top 5.
  Confirmed on the server at 01:39 UTC: reports resumed, a full run takes 26 s (was over 15 min),
  18 GB of disk free, 784 MB of data; finished days fill in one per hourly report.

- **2026-09-28** More markets. Kuru market survey on chain (every `Trade` log over 12,000 blocks,
  no address filter): only four markets traded at all, MON/USDC ($1.1M/h, 6,600 trades/h),
  cbBTC/USDC ($324k/h, 1,036/h, 3.4 bps spread, $167k within 10 bps), WETH/USDC ($268k/h, 725/h,
  1.9 bps, $67k) and XAUt0/USDC ($93k/h, 658/h, 0.6 bps, $55k); all 0/0 fees. MON/AUSD, AUSD/USDC
  and emo/MON: no trades, empty books. The three new ones are recorded by a second process
  (`jev-markets`) into their own databases: one batched book read for all of them every 2 blocks,
  one log query for all their trades (every block covered), about 8 more RPC calls/s (total ~21 of
  the ~25 allowed). Analyzer and backtester run unchanged on each: horizons in blocks, sizes in USD,
  gas priced in MON from the control (the backtest had been pricing gas at the market's own mid,
  which would have made gas on BTC 0.036 BTC; fixed). Status page: cross-market tables (volume,
  trades/h, spread distribution, touch and depth, reference freshness, lag and absorption after
  1/3/5/10/20 blocks, gas, gap frequency, gross and net edge, resting-order markouts, lag taking
  at $5/$50/$250 on unseen data). The agent also analyses each market's finished days, and trims
  the recorder logs in place (it used to swap the file, which left the recorder writing to the
  old, deleted one).
  Confirmed on the server (first hour, 03:38 UTC): `jev-markets` running at 160 MB, every
  expected book sample recorded, 0 read errors, every reference venue live (Binance quotes BTC and
  ETH); the control unchanged (93% of blocks over 24 h, 1 read error in the hour). First hour,
  anecdote only: no gaps over 5 bps on any new market, and resting orders lose before gas on all
  three (-0.1 to -1.2 bps at 33 blocks).

## Decisions

| Date | Decision | By |
|---|---|---|
| 2026-09-24 | Keep the demo as is; build Profit Mode separately in `src/profit/` | you |
| 2026-09-24 | No real money until it proves itself on paper; budget decided after that | you |
| 2026-09-24 | Research before strategy: measure the edges (making, taking the lag, Jev) with real data first | agreed |
| 2026-09-25 | Work from cloud sessions; the VPS is reached only through GitHub (no SSH from the cloud) | you |
| 2026-09-25 | Server deploys only from the `vps` branch, only if `bun test` passes | you |
| 2026-09-25 | Build the backtester now, while data accumulates; test "take the lag" and "quote around the reference price", with Jev as an optional filter | you |
| 2026-09-26 | Change Jev's question to the next ~3 s (10 blocks, flat within 2 bps), where the Bybit/OKX lead lives | you |
| 2026-09-27 | One branch: `vps` only; the session's old working branch `claude/funny-bohr-xvrfex` is retired (nothing pushes to it) | you |
| 2026-09-28 | Research the other busy Kuru markets with the same baseline, no per-market tuning; MON-USDC keeps recording through day 7 as the control; Jev v3 frozen | you |
| 2026-09-28 | Markets: cbBTC/USDC, WETH/USDC, XAUt0/USDC (the only other Kuru markets that traded in the survey); books every 2 blocks to respect the public RPC limit | agreed |
| 2026-10-02 | Disk and memory managed by the agent itself, right up to the last day (guard tiers in docs/VPS-SETUP.md); I check the reports daily until the stop | you |
| 2026-09-28 | Storage: all recordings together grow ~800 MB a day (the extra markets ~550 of it); accepted for up to 10 days (to ~2026-10-08), then stop or trim the extra markets | you |

## Verdict at the planned stop (2026-10-08, 14 days of MON-USDC, 10 of the extra markets)

**Does any high-volume Kuru market have a repeatable edge that survives realistic costs and unseen
data? No.** Measured with the corrected accounting (exit at the touch, gas on both legs, one block of
latency, queue position, train 60% / test 40%) and no per-market tuning:
- **cbBTC/USDC, WETH/USDC, XAUt0/USDC:** Kuru follows the reference exchanges within a few blocks and
  almost never leaves a gap worth taking (0 gaps over 10 bps an hour on most days); the few small
  gaps lose 4 to 13 bps each net; 0 of 54 lag variants positive on most market-days and the rare
  positives were 2 to 4 trades; resting orders earn 0 to 3 bps before ~2 bps of gas per quote placed
  and quoting variants that win one day lose the next.
- **MON/USDC (control):** the Bybit/OKX lead was real on days 1 to 4 (corr ~0.3), but trading it never
  cleared costs on unseen data, and since 09-28 activity collapsed ($4.3M/h on 09-26 to ~$50k/h), the
  book is thin and wide (14 to 19 bps, ~$400 of depth) and every taker or maker test loses.
- **Jev v3:** worse than the one-line "lead" rule, the prior and the logistic baseline on every day
  (log loss 1.07 to 1.27 vs 0.81 to 1.06); its lean moves price ~1 bps vs ~23 bps for a taker round
  trip. It earns no role.
- **Caveat:** most of the window was a quiet market (volume fell 20x to 100x after 09-28), so this is
  "no edge in what we could measure", not a claim about a busy Kuru. Phase 3 (paper trading) is not
  justified by this data.

**Operations:** the extra markets were stopped by the disk guard on 10-08 at 00:00 UTC (disk at 5 GB
free, 83% used, mostly other tenants); their databases (3.1 GB) are kept. The control keeps recording
and the guard keeps managing the disk.

## Disk guard (2026-10-02)

Free space fell 3 GB in four hours on 10-01 for a reason outside our data, so the agent now guards
the disk without anyone logging in: exchange ticks older than 24 h are trimmed from the extra
markets every 6 h (the largest table, never read by any analysis; growth should drop sharply), and
if free space still runs low it escalates: under 9 GB the control's ticks are trimmed hourly, under
6 GB the extra markets stop, under 3.5 GB their databases are deleted (finished days stay in the
reports), under 2 GB the control stops too and restarts at 6 GB. Nothing changes in the control's
measurements. RAM: recorders use ~160 MB each against a 512 MB cap; free RAM is in `agent.txt`.

**Disk guard, first day (2026-10-03):** data grew 0.2 GB over 24 h (was 0.65), so trimming the ticks
works; free disk 10 GB, RAM 5.3 GB free of 7.8, recorders ~160 MB each. One bug found: the extra
markets' recorder crashed and was restarted by systemd at the start of each tick trim (10:06,
16:11, 22:17 UTC), losing ~5 s of data each time, because the recorder did not wait for the
trim's database lock. Fixed: recorders now wait for the lock and keep rows if a write fails; trims
use smaller batches.

**2026-10-04 check:** the lock fix held: both recorders ran 23.5 h without a restart through three tick
trims. Data 4.2 GB (+0.4 GB a day), free disk 9.6 GB (the guard's first tier starts below 9 GB and only
trims the control's ticks), RAM 5.4 GB free, recorders ~165 MB (systemd shows ~350 MB including
reclaimable file cache). Still no edge: on the extra markets 12 of 54 lag variants looked positive
for WETH on 10-02 but on 2 to 4 trades each (noise; the tuned pick made no trades); the control's
gaps lose 29 bps net (its book is ~19 bps wide with ~$400 of depth, volume $45k/h).

**2026-10-05 check:** healthy and no restarts for 47 h. Data 4.7 GB (+0.4 GB a day), free disk 9.1 GB
(tier 1 starts below 9 GB), RAM 5.4 GB free. systemd shows both recorders at their 512 MB cap, but
that is file cache from the databases (resident memory is flat at 163 to 168 MB, no skipped heads on
the extra markets), and the kernel reclaims it. Data quality to verify tomorrow: since 00:00 UTC
today XAUt0 shows a dislocation (264 reference-gap trades at -310 bps net, resting orders -62 bps)
and the control's 24 h spread p90 is 376 bps, although XAUt0's median spread (2.8 bps) and mid
(~4,140) are normal. It looks like a stretch of one-sided or empty thin books; the full-day files
for 10-05 will show it. These are losses, not an edge, but they distort the cross-market averages.

**2026-10-06 check:** healthy; both recorders up 71 h with no restarts. Data 5.1 GB, free disk 8.3 GB
(75% used; it fell 0.8 GB since yesterday against 0.4 GB of our own growth, so other tenants are
using the rest): the guard is in tier 1 (trimming the control's ticks hourly); the 6 GB tier that
stops the extra markets would be reached around 10-09 to 10-10 at this rate. RAM 5.3 GB free.
XAUt0's book has degraded: its spread p90 is 19,980 bps (one side is dust) and it logged 223 read
errors, so its "resting order +398 bps" and "gaps 993 an hour" are artifacts of a meaningless mid,
not an edge; the cross-market tables now flag such markets (spread p90 over 100 bps). cbBTC and
WETH: no gaps, resting orders +0.7 bps before ~2.1 bps of gas. Control: gaps lose 26 bps net.
No edge anywhere.

**2026-10-07 check:** both recorders up 24 h since the last deploy, no crashes; one transient agent push
failure (10-06 12:59). **Disk is the open problem:** free space fell from 7.8 GB to 6.3 GB in a day
(data +0.5 GB, so ~1 GB went to other tenants); the 6 GB tier that stops the extra markets is
hours away, by design (their data stays; the control keeps recording). The agent report now lists
the size of each data item and of the home directory, to show who uses the space. XAUt0's book
recovered (spread p90 3 bps, but 4,654 read errors in 24 h); the control's p90 spread is now 883 bps
(flagged). cbBTC, WETH, XAUt0: no gaps worth trading, resting orders +0.8, +2.8, -0.5 bps before
~2 bps gas; control gaps lose 60 bps net. Jev v3 1.07 vs 0.81 for the best baseline. No edge anywhere.

## Day 7 and 8 check (2026-10-02 03:00 UTC, 96 h of the extra markets)

Recorders healthy (extra markets 574k samples each, 1 request error; control 3 read errors in 96 h,
3,795 skipped heads, 125 Jev errors of 21,726 calls). Two transient `git fetch` failures in the
agent on 10-01 (16:59, 17:03), nothing lost.

**Disk needs a look.** Data is 3.6 GB (+0.6 GB a day, as planned), but free space fell from 14 GB
to 11 GB between 10-01 10:42 and 14:51 while our data grew 0.1 GB: something else on the shared
server took ~3 GB. At our rate the 10-day plan (to ~10-08) ends near 7 GB free, if nothing else grows.

**Activity partly back, still far below 09-26:** survey 10-01 04:26 UTC: MON/USDC $159k/h
(1,208 trades/h), cbBTC $55k/h, WETH $30k/h, XAUt0 $0.9k/h. MON-USDC spread ~18 bps, depth within
10 bps ~$0.5k.

**Still no edge anywhere, now over 5 full days on the extra markets' last 2:**
- cbBTC / WETH / XAUt0, days 09-30 and 10-01: no gaps over 5 bps; the few 2 bps gaps lose 6.6 to
  10.4 bps net; 0 of 54 lag variants positive on every one of the 6 market-days. Resting orders
  earn +1.6, +1.5, +0.5 bps at 33 blocks before gas (new: positive) against ~2.4 bps gas per quote
  placed, so still negative once gas is paid. Quoting variants positive on unseen data: 25/60 and
  17/60 on 09-30, then 1/60 and 1/60 on 10-01: it does not repeat.
- Control: gaps over 20 bps lose 27 bps net (10-01: 209 trades), resting orders -4.96 bps, lead-lag
  corr 0.19. The reference signal is backwards on a thin, wide book.
- **Jev v3 (6 days, ~2,100 held-out forecasts a day):** log loss 1.13 to 1.27 every day, worse than
  the lead rule (0.86 to 1.07), the prior and the logistic baseline on all 6 days. Last 24 h: jev
  1.236, lead 1.019, logistic 1.014; lean moves +1.0 bps vs ~23 bps a taker round trip. By the
  rule in docs/PROFIT.md it gets no role.

**Day 7 checkpoint:** no market has an edge that survives costs and unseen data, and Jev v3 does
not beat simple baselines. The quiet period means this is "no edge in a quiet market" more than a
final verdict on Kuru. Options for you: stop at ~10-08 as planned, or keep the control running
longer to see a busy day again (cheap: ~0.25 GB a day for MON-USDC alone if the extra markets are
stopped).

## Day 5 check (2026-09-30 04:20 UTC, 49 h of the extra markets)

Recorders healthy (extra markets 291k samples each, 1 request error; control 2 read errors in 49 h,
1,721 skipped heads, 96 Jev errors of 11,027 calls). Disk 15 GB free, data 2.3 GB (+0.7 GB a day).

**The Day 4 change on MON-USDC was not a thin book: Kuru's activity collapsed on every market.**
The on-chain survey (independent of our recorders) at 03:34 UTC agrees with them:

| Market | $/h on 09-26 | 09-28 | 09-29 | survey now |
|---|---|---|---|---|
| MON/USDC | 4.3M | 1.2M | 102k | 28k (475 trades/h, 5 makers) |
| cbBTC/USDC | | 190k | 36k | 9k (76/h) |
| WETH/USDC | | 228k | 61k | 6k (31/h) |
| XAUt0/USDC | | 58k | 11k | 0.6k (14/h) |

MON-USDC spread is now ~15 bps and depth within 10 bps ~$1k; the others' spreads and depth held
(3 to 6 bps, $5k to $60k) but almost nobody trades. Cause unknown from our data.

**Still no edge on any market.** Day 09-29: no gaps over 5 bps on the three new markets (2 bps gaps
lose 4.4 to 7.2 bps net; 0 of 54 lag variants positive on each); resting orders +0.28 (cbBTC),
-0.10 (WETH), +0.17 (XAUt0) bps before gas at 33 blocks, gas ~2 bps a quote; quoting variants
positive on unseen data only 12/60, 0/60, 1/60 with negative chosen results. Control: gaps over 20
bps 14 trades at -5.3 bps net; lead-lag corr back to 0.20; reference feeds unchanged (Bybit, OKX,
Coinbase live; Binance never quotes MON). Jev v3 still worse than the lead rule (log loss 1.19 vs
0.93).

**Consequence for the plan:** a few days of near-empty markets say little about a normal market and
there is nothing to trade against. Days 09-25 to 09-28 are the busy sample; the day 7 checkpoint still
happens, but will be read as "no edge in a quiet market", not a final verdict. If activity does
not return, extending the recording past day 7 is worth more than the extra markets.

## Day 4 check (2026-09-29 04:00 UTC, 25 h of the extra markets)

All recorders healthy (extra markets: 151k samples each, 1 request error; control: 1 read error,
95% of blocks); disk 16 GB free, data 1.6 GB (~32 MB an hour, as expected).

**Extra markets, first full day (09-28), no edge:** essentially no price gaps to trade (0 gaps over
10 bps per hour on any of them); the few 2 bps gaps lost 4.5 to 7.5 bps each after costs (win rate
4 to 8%). Resting orders: cbBTC +0.4 bps, WETH -0.2, XAUt0 -0.8 at 33 blocks before gas, against
~2 bps of gas per quote. Kuru tracks the reference closely there (corr 0.4 to 0.6, 60 to 90%
absorbed within 10 to 20 blocks), so there is little lag left to take. Backtests: 0 of 54 lag
variants positive on every market.

**Control (MON-USDC) changed in the last 24 h:** median spread 9.3 bps (was ~3.8), depth within
10 bps $1.5k (was $7k), lead-lag correlation 0.06 (was 0.28 to 0.35), and gaps over 10 bps now
lose 14.5 bps net (27% winners; gross -10.6). The signal is not just weak but backwards, which
points at a thin book (noisy mid) or a stale reference rather than a new edge. To check at Day 5:
whether it persists, and whether the reference feed itself changed.

## Day 3 review (2026-09-28; the latest report is from 2026-09-27 05:01, 52 h of data)

**Reports stalled.** After 2026-09-27 05:01 the server pushed nothing (and had already skipped
some hours). The recorder was healthy in the last report. Most likely cause: every hourly report
re-analysed the whole recording (now over 1 GB) inside the agent's 1 GB / 15-minute limits, and
every time-based query scanned the whole database because `ts` had no index; once a run passed
15 minutes, systemd killed it before it pushed anything. Fixed the same day (see Done).

**Corrected numbers (exit at the touch, gas and fees on both legs), 52 h:** gaps over 20 bps
still made money at 200 MON: +4.2 bps per trade over 40 trades (53% winners), and by day +2.6
(18 trades) on 09-25 and +5.6 (21 trades) on 09-26. That is about $0.04 a day at 200 MON: real
but tiny, and the backtest's pick for bigger orders (30 bps, 10,000 MON) lost on its unseen
hours. Lead-lag unchanged (0.28 at one block). Jev v3 unchanged: log loss 1.13 vs 0.84 for the
lead rule. Nothing new that clears costs at a useful size.

## Day 2 review (2026-09-27, 48 h of data)

**Memory: no leak.** Measured after garbage collection every minute for 21 hours: 166 to 169 MB
resident, 67 MB heap, flat. The 358 MB systemd shows is reclaimable file cache.

**Market:** about 4x busier than day 1 (~$2.5M an hour, 3,700 prints an hour); the typical print
now takes the whole best level (~19,000 MON). 54 takers, 13 makers. Median spread 3.8 bps.

**Lead-lag: stable across both days.** Correlation 0.28 one block later; Kuru absorbs 40% of a
Bybit/OKX move in 1 block, 60% in 3, ~70% by 30. This is the one robust pattern so far.

**Resting orders:** over 48 h, roughly break-even before gas (+0.1 bps at 33 blocks), so any gas
makes them lose. All realistic quoting variants lost on the unseen period.

**Big-gap lag taking: did not hold.** The analyzer showed gaps over 20 bps paying ~9.5 bps on both
days (40 trades in 48 h), but the backtest's pick from day-2 tuning (30 bps, 10,000 MON) lost on
the unseen 9.6 h (18 trades, 22% winners). Part of the gap was the analyzer's own optimism
(exit at mid, one gas), fixed today; the rest is small samples. Not an edge yet.

**Jev v3 (~3 s question): some signal, but less than simple rules.** On 1,957 held-out forecasts:
log loss 1.14 vs 0.86 for the "lead" rule and 0.76 for the logistic baseline (lower is better);
it under-predicts "flat", which is 73% of outcomes. Unlike v2 its lean now points the right way
(+0.5 to +1.1 bps when it leans), but the lead rule (+1.4 bps) and the logistic baseline (+2.5 bps
when it leans) do better, and none comes near the ~7.4 bps a taker round trip costs.

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

**Widened backtest (2026-09-26 01:19 UTC, same 24 h):** big-gap lag taking is the only thing that
made money on the unseen 9.5 h, and barely: the best settings (gaps over 30 bps, 2,000 MON orders)
made about $0.005 an hour from 6 to 12 trades, 67 to 83% of them winners; 38 of 108 variants were
positive, all at tiny amounts. Wider and calmer quoting still lost on every variant (the wide quotes
only get filled when the price is about to run through them). Memory right after the restart:
168 MB resident, 75 MB heap; the next reports show whether that grows.

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
