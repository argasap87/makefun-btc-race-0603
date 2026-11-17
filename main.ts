// Eight-Hour Anchor — a long-only cbBTC/USDC range bot for agent-fun/bars-replay/v1.
//
// Idea, in one line: the dev window is a choppy, range-bound day (net +0.49% over
// 24h, biggest 60-minute swing 2.3%, buy-and-hold max drawdown only 2.1%), so this
// bot buys sharp dips below a slow 8-hour anchor and sells the snap back above it,
// instead of chasing momentum that does not persist here (15-minute momentum
// continuation on the dev window is 42/93, a coin flip).
//
// Rules, decided on each 1-minute bar's close (the order fills at the next bar's
// open, so every threshold is read off closes, never off the fill price):
//   - Anchor: the mean and population standard deviation of the last 480 closes
//     (8 hours). A short window whipsaws on this data (60/120/240-bar anchors all
//     lose money in the offline sim); the 8-hour anchor is the day's range.
//   - Entry, flat only: close < mean - 1.0 * sd, the last 30 bars fell at least
//     0.15% (a real pullback, not a flat drift), and the band is at least 15 bps
//     wide (no trading a dead-flat tape). Full equity, one position, long only.
//   - Exit, the whole position, whichever comes first:
//       * take profit: close >= mean + 1.0 * sd (the snap back overshoots the anchor),
//       * hard stop: close 2% under the fill price,
//       * breakdown: close < mean - 2.5 * sd (the range broke; stop catching knives),
//       * max hold: 360 bars after the fill (6 hours; a dip that never snaps back
//         is exited rather than ridden into the close).
//   - After any exit, a 15-bar cooldown before the next entry, so one whipsaw does
//     not chain into a second trade on the same wiggle.
//   - Every order caps slippage at 150 bps; a fill the market refuses is simply
//     re-decided on the next bar while its condition still holds.
//
// Determinism: the bot reads only the bar stream it is handed (hello, batch,
// orders, bar — the protocol's own words). No clock, no environment, no files,
// no randomness; the same bars always produce the same orders.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Bars in the anchor window: 480 one-minute closes = 8 hours. */
const ANCHOR_BARS = 480;
/** Entry: this many anchor sigmas below the anchor mean. */
const ENTRY_SIGMAS = 1;
/** Exit: this many anchor sigmas above the anchor mean. */
const EXIT_SIGMAS = 1;
/** Entry needs a real pullback: 30-bar return below -0.15%. */
const PULLBACK_BPS = 15;
/** Entry needs a live band: entry sigma-width at least 15 bps of the mean. */
const MIN_BAND_BPS = 15;
/** Hard stop: 2% under the fill price. */
const STOP_BPS = 200;
/** Breakdown exit: this many sigmas below the anchor mean. */
const BREAKDOWN_SIGMAS = 2.5;
/** Max hold after a fill, in bars. */
const MAX_HOLD_BARS = 360;
/** Bars to wait after an exit before the next entry. */
const COOLDOWN_BARS = 15;
/** Slippage cap on every order, in bps. */
const MAX_SLIPPAGE_BPS = 150;

/** Closes seen so far, oldest first, in raw price units (price_scale 5). */
const closes: number[] = [];
/** Fill price of the open position (raw units), null while flat. */
let entryPrice: number | null = null;
/** Seq of the batch whose fill opened the position, -1 while flat. */
let entrySeq = -1;
/** First seq on which a new entry may be decided again. */
let coolUntilSeq = -1;

/** Mean and population sd of the last ANCHOR_BARS closes, or null before then. */
function anchor(): { mean: number; sd: number } | null {
  if (closes.length < ANCHOR_BARS) return null;
  const start = closes.length - ANCHOR_BARS;
  let sum = 0;
  for (let i = start; i < closes.length; i++) sum += closes[i];
  const mean = sum / ANCHOR_BARS;
  let sq = 0;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - mean;
    sq += d * d;
  }
  return { mean, sd: Math.sqrt(sq / ANCHOR_BARS) };
}

/** 30-bar return ending at the latest close, in bps, or null before 31 closes. */
function pullbackBps(): number | null {
  if (closes.length < 31) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 31];
  return ((now - then) / then) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Learn from this batch's fills first: a filled buy opens the position (its
    // fill price is the stop's reference), a filled sell closes it and starts
    // the cooldown. The account in state already reflects these fills.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entrySeq = batch.seq;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        entrySeq = -1;
        coolUntilSeq = batch.seq + COOLDOWN_BARS;
      }
    }

    // Record this bar's close (one bar per batch for this universe). During the
    // warm-up the orders would be rejected anyway, but the history still counts.
    const bar = [...batch.bars].reverse().find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    if (state.warmingUp) return [];

    const close = closes[closes.length - 1];
    const band = anchor();
    if (band === null) return [];
    const held = state.positions.get(SYMBOL);
    const heldQty = held?.qty ?? 0n;

    if (heldQty > 0n) {
      // --- exit checks, whole position, first hit wins ---
      // If a fill notification was ever missed, fall back to the position's own
      // cost basis for the stop's reference price (cost / qty, rescaled from
      // quote units to raw price units) and to this bar for the hold clock.
      if (entryPrice === null && held !== undefined) {
        entryPrice = Number((BigInt(held.cost_quote_units) * 10n ** 7n) / heldQty);
      }
      if (entrySeq < 0) entrySeq = batch.seq;
      const stopPrice = entryPrice === null ? null : (entryPrice * (10_000 - STOP_BPS)) / 10_000;
      const heldBars = entrySeq < 0 ? 0 : batch.seq - entrySeq;
      const takeProfit = close >= band.mean + EXIT_SIGMAS * band.sd;
      const stoppedOut = stopPrice !== null && close <= stopPrice;
      const brokeDown = close < band.mean - BREAKDOWN_SIGMAS * band.sd;
      const heldTooLong = entrySeq >= 0 && heldBars >= MAX_HOLD_BARS;
      if (takeProfit || stoppedOut || brokeDown || heldTooLong) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry checks, flat only ---
    if (batch.seq < coolUntilSeq) return [];
    const pullback = pullbackBps();
    if (pullback === null) return [];
    const bandWidthBps = (ENTRY_SIGMAS * band.sd / band.mean) * 10_000;
    const dipped = close < band.mean - ENTRY_SIGMAS * band.sd;
    const falling = pullback < -PULLBACK_BPS;
    const liveBand = bandWidthBps >= MIN_BAND_BPS;
    if (!dipped || !falling || !liveBand) return [];

    const { caps, fees } = state.hello;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const notional = state.cash < byWeight ? state.cash : byWeight;
    if (notional <= 0n || notional < BigInt(fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
