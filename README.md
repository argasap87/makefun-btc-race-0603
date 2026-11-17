# Eight-Hour Anchor — cbBTC/USDC range bot

[![btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603)
(`btc-race-24h-20261117-0603`). Long-only cbBTC/USDC bot on 1-minute on-chain
bars, $1,000 paper USDC, one open position at most. Original strategy, written
from scratch for this competition — not a copy of any kit baseline or of the
earlier "Bounce Rider" entry.

## Strategy

The dev window is a choppy, range-bound day: +0.49% net over 24 hours, biggest
60-minute swing 2.3%, buy-and-hold max drawdown 2.1%, and 15-minute momentum
continuation is 42/93 — a coin flip. So this bot buys sharp dips below a slow
8-hour anchor and sells the snap back above it, instead of chasing momentum.

- **Anchor:** mean and population standard deviation of the last 480 closes
  (8 hours). Shorter anchors (60/120/240 bars) all lose money on the dev window
  in offline testing; the 8-hour anchor is the day's range.
- **Entry (flat only):** close below `mean − 1.0σ`, the last 30 bars fell at least
  0.15%, and the band is at least 15 bps wide. Full equity, one position.
- **Exit (whole position, first hit wins):** take profit at `mean + 1.0σ`;
  hard stop 2% under the fill price; breakdown exit below `mean − 2.5σ`;
  max hold 360 bars (6 hours). 15-bar cooldown after any exit.
- Every order caps slippage at 150 bps. Deterministic: decisions depend only on
  the bar stream — no clock, environment, files, or randomness.

## Dev-grade results (local, `--driver process`)

| metric | value |
|---|---|
| Net PnL | **+$11.72** |
| Trades | 5 (3 buys, 2 sells; final position flattened at close) |
| Max drawdown | 0.87% |
| Win rate | 67% (2 of 3 round trips) |
| Fees | $2.42 |
| Determinism | two runs reproduce the same action log byte for byte (`ce3f20fd…`) |

Buy-and-hold on the same window nets +$1.07, so the bot beats it by ~$10.65.

## How to run

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

The bot is `main.ts` (Node 22, erasable TypeScript, stdlib only, no network).
`vendor/makefun-bars.ts` is a byte-identical copy of the kit's
`sdk/makefun-bars.ts` shim, which owns the `agent-fun/bars-replay/v1` wire
protocol (one `hello`, then one `batch` per minute bar, one `reply` per batch).
