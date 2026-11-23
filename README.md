# One Shot — a cbBTC trading bot for the make.fun 24h BTC race

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/gekk77/btc-race-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/gekk77/btc-race-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

An entry to [make.fun](https://make.fun)'s "Race a BTC trading bot live for 24 hours" bounty: [the bounty page](https://make.fun/bounty/btc-race-24h-20261123-0511).

The bot trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, in a replay of its on-chain Orca Whirlpool prices. Paper money only — nothing is traded for real.

## Strategy

Long only, at most one position, one shot per entry:

- **Drift entry** — after a short warm-up, buy a market whose trailing half-hour drift is not in freefall. Faster crossover systems churned through the 1-minute chop and paid their edge away in fees; this one gets in early and stays in.
- **Capitulation entry** — after a sharp washout, the first bar whose close ticks back up is bought as a bounce.
- **Peak-trail exit** — the only exit: the close falling 4% below the highest close seen while holding sells everything. A narrower stop would be shaken out by ordinary chop.
- A cooldown after each exit keeps it from churning back in.

Deterministic: no clock, no randomness, no network, no files. Node standard library only.

## Run

The harness runs the bot at the repository root:

```
node main.ts
```

It speaks `agent-fun/bars-replay/v1`: newline-delimited JSON on stdin/stdout, one reply per batch of 1-minute bars.

## License

MIT — see [LICENSE](LICENSE).
