# Profit Mode

The demo (`src/*.ts`, `web/`) exists to show an AI trading every block. Profit Mode (`src/profit/`)
exists to find out whether a bot on Kuru MON-USDC can make money, and to only risk money once the
data says yes. The two share the chain plumbing (`chain.ts`, `book.ts`, `trades.ts`) and nothing else.

## Phases and gates

| Phase | What | Money at risk | Gate to move on |
|---|---|---|---|
| 0. Record | `bun run record` on a server, 1 to 2 weeks | none (Jev: a few cents a day) | clean recording: >90% of blocks, reference venues live |
| 1. Research | `bun run analyze` | none | at least one edge that clears costs, stable day to day (below) |
| 2. Backtest | replay the recording with queue position, one-block latency, gas, fees, reverts | none | positive out of sample, on days not used for tuning |
| 3. Paper trade | the strategy live on real data, simulated fills, honest costs | none | matches the backtest for 2+ weeks |
| 4. Small live | a few hundred dollars, hard limits, kill switch | small | positive and in line with paper for weeks; budget decided then |

Where we are: **phase 0 is built** (recorder, analyzer, tests). Nothing in Profit Mode signs or
sends a transaction.

## What gets recorded

`data/profit.sqlite` (WAL mode, so the analyzer can read while the recorder writes):

- `books`: every block's Kuru top 5 levels, spread, imbalance, depth bands, plus the latest quote
  from each reference exchange at that moment.
- `trades`: every Kuru `Trade` log (taker side, price, size, maker, taker, tx).
- `ref_ticks`: best bid/ask from Binance, Bybit, OKX and Coinbase (whichever list MON), at most
  every 250 ms per venue.
- `predictions`: every 50th block (~15 s), Jev's up / down / flat forecast for the next 100 blocks (~30 s),
  with the exact state it saw, its latency and TypeSafe's confidence.
- `meta`: market parameters, including Kuru's taker and maker fees read from the contract.

About 300 MB a day. `GET http://127.0.0.1:3101/health` returns 200 while fresh, 503 when the last
book is over 10 s old, with per-venue status and Jev error counts.

## What the report answers

`bun run analyze` (last 72 h by default; `--hours N`, `--hours all`, `--json`):

1. **Is there flow?** Prints and MON per hour, spread, touch size, how many distinct takers.
2. **Would a resting order pay?** For every print, what the maker earned: half-spread captured
   minus how far mid moved against them 1, 10, 33, 100 and 333 blocks later, after the maker fee.
   Compare with gas per quote (0.036 MON on a 200 MON order is 1.8 bps, and every re-quote pays it
   again). If this is not clearly positive at 10 to 30 s, passive market making cannot work here.
3. **Does Kuru follow other exchanges?** Correlation of reference moves with Kuru moves at each lag,
   and how much of a reference move Kuru has absorbed after 1, 3, 10, 30, 100 blocks.
4. **Can we trade the lag?** Buy Kuru's ask (sell its bid) when the reference says it is cheap
   (dear) by more than a threshold, filled a block late, marked 33 blocks later, after the taker fee
   and gas. The steady USD/USDT/USDC basis between venues is removed with a trailing mean.
5. **Does Jev know where price goes?** On the last 40% of forecasts (never trained on): accuracy,
   log loss and Brier score for Jev and three baselines (class frequencies, 20-block momentum, a
   logistic regression on the same features Jev sees), plus the average signed move when the
   forecast leans one way. Jev earns a role only if it beats all three out of sample.

`bun run scripts/profit-synth.ts data/synth.sqlite && bun run analyze --db data/synth.sqlite`
runs the report on a synthetic market with a planted 3-block lag, to see what each section looks
like when there is something to find.

## What counts as "an edge"

Phase 1 passes if any one of these holds across several separate days (run `--hours 24` per day):

- **Making**: maker net markout at 33 blocks is above 2x gas per quote, and prints per hour are
  enough to pay for the quotes that do not fill.
- **Taking the lag**: some threshold has a positive net after fee and gas, a win rate above 55%, and
  enough trades per hour to matter.
- **Jev**: beats every baseline on log loss, and its signed move when confident beats a taker round
  trip (printed at the bottom of the report), or it can be shown to improve the making markouts.

If none holds after two weeks, the honest conclusion is that this market does not have an edge for
us, and the loss is time plus a few dollars of Jev calls.

## Running it on the server

docs/VPS-SETUP.md: an unprivileged user runs the recorder and an agent that deploys from the `vps`
branch (only when `bun test` passes) and pushes an hourly status page to a private reports repo.
The cloud session never logs in to the server.

## Tracking progress

- **Live status:** the reports repo README (recorder health, venues, deploy, automatic gate checks).
- **Project log:** docs/PROGRESS.md (phase table, done, decisions, what is waiting on whom, next).
