// Trend-and-capitulation bot for the cbBTC/USDC 1-minute bars race.
//
// Speaks agent-fun/bars-replay/v1 directly: newline-delimited JSON on
// stdin/stdout, one reply per batch echoing its seq. Orders decided on
// the batch of bar t fill at the open of bar t+1, so every signal below
// is computed only from bars already closed when the reply is written.
//
// Strategy (long only, at most one position, one shot per entry):
//   - Drift entry: once a short warm-up has passed, buy a market whose
//     trailing half-hour drift is not in freefall. On a rising window
//     this is in early and stays in; faster crossover systems churned
//     through the 1-minute chop and paid their edge away in fees.
//   - Capitulation entry: after a sharp washout over the lookback window
//     (trailing return below the dip threshold), the first bar whose
//     close ticks back up from the prior close is bought as a bounce.
//   - One exit only: the peak trail. The close falling a wide fraction
//     below the highest close seen while holding sells everything; a
//     narrower stop would be shaken out by ordinary chop.
//   - A cooldown after the exit keeps the bot from churning back in and
//     paying the round-trip cost twice.
//   - Size is a fixed share of the cash on hand, spent in a single order.
//
// Deterministic: no clock, no randomness, no environment, no files.
// Node standard library only.

import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';

const FAST_PERIOD = 120;
const SLOW_PERIOD = 480;
const DRIFT_BARS = 30;
const DRIFT_FLOOR = -0.01; // enter while the drift is above -1%
const DIP_BARS = 240;
const DIP_MIN = -0.03; // washout: trailing return at or below -3.0%
const SIZE_BPS = 9500n; // spend 95% of cash on an entry
const TRAIL_STOP = 0.04; // exit 4.0% below the peak close while held
const COOLDOWN_BARS = 60;
const MIN_BARS = 46; // earliest bar an entry may be decided on
const MAX_SLIPPAGE_BPS = 400;
const FALLBACK_MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

/** One exponential moving average over closes, kept as float64. */
class Ema {
  private k: number;
  value: number | null = null;

  constructor(period: number) {
    this.k = 2 / (period + 1);
  }

  push(x: number): number {
    if (this.value === null) {
      this.value = x;
    } else {
      this.value += (x - this.value) * this.k;
    }
    return this.value;
  }
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
}

class Bot {
  private warmup = 0;
  private minNotional = FALLBACK_MIN_NOTIONAL;
  private seq = -1;
  private cash = 0n;
  private qty = 0n;
  private fast = new Ema(FAST_PERIOD);
  private slow = new Ema(SLOW_PERIOD);
  private closes: number[] = [];
  private entryClose: number | null = null;
  private peakClose: number | null = null;
  private cooldownUntil = -1;
  private orderCount = 0;

  onHello(hello: any): void {
    this.warmup = Number(hello.warmup_bars ?? 0);
    this.cash = BigInt(hello.capital.quote_units);
    const min = hello.fees?.min_notional_quote_units;
    if (min !== undefined) this.minNotional = BigInt(min);
  }

  private applyAccount(account: any): void {
    this.cash = BigInt(account.cash_quote_units);
    this.qty = 0n;
    for (const pos of account.positions ?? []) {
      if (pos.symbol === SYMBOL) this.qty = BigInt(pos.qty);
    }
  }

  private nextId(tag: string): string {
    this.orderCount += 1;
    return tag + String(this.orderCount);
  }

  private buyOrder(): Order | null {
    const notional = (this.cash * SIZE_BPS) / 10_000n;
    if (notional < this.minNotional) return null;
    return {
      side: 'buy',
      client_id: this.nextId('b'),
      symbol: SYMBOL,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  private sellOrder(): Order | null {
    if (this.qty <= 0n) return null;
    return {
      side: 'sell',
      client_id: this.nextId('s'),
      symbol: SYMBOL,
      qty: this.qty.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  private enter(): Order[] {
    const order = this.buyOrder();
    if (order === null) return [];
    this.entryClose = this.closes[this.closes.length - 1];
    this.peakClose = this.entryClose;
    return [order];
  }

  private decide(): Order[] {
    if (this.seq < this.warmup) return [];
    if (this.closes.length < MIN_BARS) return [];
    const n = this.closes.length;
    const close = this.closes[n - 1];
    const prevClose = this.closes[n - 2];

    if (this.qty > 0n) {
      // One exit only: the peak trail. A wide trail keeps the bot from
      // being shaken out by the chop that fills a 1-minute window.
      if (this.peakClose === null || close > this.peakClose) {
        this.peakClose = close;
      }
      if (this.peakClose !== null && close <= this.peakClose * (1 - TRAIL_STOP)) {
        const order = this.sellOrder();
        if (order !== null) {
          this.entryClose = null;
          this.peakClose = null;
          this.cooldownUntil = this.seq + COOLDOWN_BARS;
          return [order];
        }
      }
      return [];
    }

    // Flat: enter a market that is not in freefall, or buy the first
    // uptick after a washout (the capitulation bounce).
    if (this.seq < this.cooldownUntil) return [];
    const driftPast = this.closes[n - 1 - DRIFT_BARS];
    const drift = driftPast ? close / driftPast - 1 : 0;
    if (drift > DRIFT_FLOOR) {
      return this.enter();
    }
    if (n > DIP_BARS) {
      const dipPast = this.closes[n - 1 - DIP_BARS];
      const dipReturn = dipPast ? close / dipPast - 1 : 0;
      if (dipReturn <= DIP_MIN && close > prevClose) {
        return this.enter();
      }
    }
    return [];
  }

  onBatch(batch: any): Order[] {
    this.seq = Number(batch.seq);
    for (const bar of batch.bars ?? []) {
      if (bar.symbol === SYMBOL) {
        const close = Number(bar.c);
        this.closes.push(close);
        this.fast.push(close);
        this.slow.push(close);
      }
    }
    this.applyAccount(batch.account);
    return this.decide();
  }
}

function main(): void {
  const bot = new Bot();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.type === 'hello') {
      bot.onHello(msg);
    } else if (msg.type === 'batch') {
      const orders = bot.onBatch(msg);
      const reply = { type: 'reply', seq: msg.seq, orders };
      process.stdout.write(JSON.stringify(reply) + '\n');
    } else if (msg.type === 'done') {
      process.exit(0);
    }
  });
}

main();
