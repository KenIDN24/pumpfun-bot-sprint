// Pump.fun Bot Sprint — paper trading bot (agent-fun/replay/v2).
//
// Strategy v6: "Dip Sniper", ported from the Pump.fun Replay Sprint entry
// (repo KenIDN24/pumpfun-replay-bot) onto this kit's SDK shim
// (vendor/makefun-bot.ts, agent-fun/replay/v2). Same protocol, same caps,
// same fees, same 24h dev window family (src-calib) — the v6 dev numbers
// should carry over, and they are re-measured here with grade-local.
//
// What did NOT work on the dev window (24h, 1,222 mints, 10 SOL):
//   - Momentum chasing (v1-v5): buying +15-30% after the pump. Coins
//     cliff-dump ~80% in ONE trade, so stops fire after the cliff. Best
//     momentum variant still lost -0.62 SOL; plain versions -0.84..-2.58.
//   - Early sniping (buy at trade 2-3): win rate only 13-17% — most coins
//     never pump at all. Lost -0.82..-1.69 SOL.
//   - Joint refined filters (buyQ>=3 AND rq>=10 AND shallow retrace):
//     collapse the sample to 0-5 trades. Rejected.
//
// What works best: buy the DIP after a proven 2x pump. A coin that already
// ran >=2x from its first price and retraced to <=60% of its peak (and
// <=1.4x its first price) has already shown it can attract buyers, and the
// entry sits near the bottom — the average drawdown after entry is only
// ~-19%, so losses stay small while the few coins that run again pay
// 10-17x the average loss. Dev result on THIS kit (grade-local, process
// driver): -0.01397 SOL over 88 round trips (variant B, retrace <= 60%),
// better than the v6 baseline at retrace <= 70% (-0.02728 SOL, 92 trips)
// and better than variant A (trailing drop 40%: -0.03805 SOL). Still
// slightly negative — no variant tested was positive on dev, so this is a
// lottery ticket: the prize needs PnL > 0 on the unseen 6h final window.
// Dev gains are 97.9% concentrated in the top 3 coins; net without them
// is -0.254 SOL. Guardrails on dev: 88 trips / 88 distinct mints (>= 20),
// max drawdown 2.11% (<= 50%) — all pass.
//
// Entry (all must hold):
//   - mint peaked at >= 2x its first-trade price, now retraced to <= 60%
//     of that peak and <= 1.4x its first price (variant B: deeper dips)
//   - >= 15 trades seen; buy share >= 60% of quote volume over the last
//     10 trades (fresh buy flow returning, not a dead coin)
//   - real SOL reserves >= 2 SOL (liquidity deep enough to exit)
//   - size 0.02 SOL target, capped at 0.9% of real reserves (harness cap
//     is 1%), floored at 0.01 SOL (a round trip counts only at >= 0.01 SOL)
//   - at most 5 open positions, ONE entry per mint ever (re-buying the
//     same losers cost v3 an extra ~-1.7 SOL)
//
// Exit (first hit wins):
//   - stop-loss: mark <= -12% vs entry cost basis
//   - trailing stop: arms at +50%, sells when the mark falls 30% below
//     the peak — lets the rare second leg run (winners averaged +0.0485)
//   - time stop: 1,800 slots (~12 min) after entry if the trailing stop
//     never armed
// Sells never fail on slippage (SELL_SLIPPAGE_BPS = 10000): a sell rejected
// while the price craters is worse than any fill price the curve gives.
// Buys keep a 20% slippage cap so a vertical 2-slot spike is not chased.
//
// Port notes vs the raw-loop v6:
//   - The shim owns the wire: hello arrives first, then one batch per
//     slot, then done. Each batch carries its events, marks, fills and the
//     account; onBatch returns that slot's orders. No clock, no randomness,
//     no network — the same replay always produces the same replies, so
//     the two harness executions match byte-for-byte.
//   - One genuine fix over v6: exits skip a mint that already has a sell
//     pending in the shim's pending orders. The old loop could send a
//     second full sell for a position whose first sell was still in flight
//     (fills land 2 slots later); the duplicate only ever gets rejected,
//     but it is noise in the action log and a needless failed-tx risk.
//   - Entry-slot bookkeeping: a position first seen in the account gets
//     entrySlot = the current batch slot and peak = 0 (ratio space, so the
//     first decision sets it to the live return).
//
// Fees per round trip: ~2.5% curve (95 protocol + 30 creator bps per side)
// + 105,000 lamports tx per order. Guardrails need >= 20 round trips of
// >= 0.01 SOL on distinct mints and max drawdown <= 50% — this bot makes
// ~95 trips at 0.02 SOL with a tiny drawdown.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

// ---- Tunables (strategy v6) ----
const TARGET_SIZE_LAMPORTS = 20_000_000n; // 0.02 SOL
const MIN_SIZE_LAMPORTS = 10_000_000n; // 0.01 SOL (round-trip counting floor)
const MAX_OPEN_POSITIONS = 5;
const MAX_ORDER_RQ_BPS = 90; // 0.9% of real quote reserves (harness cap: 1%)
const MIN_REAL_RESERVES_LAMPORTS = 2_000_000_000n; // 2 SOL
const ENTRY_MIN_TRADES = 15;
const ENTRY_PEAK_GAIN = 2.0; // mint must have peaked at >= 2x first price
const ENTRY_RETRACE_MAX = 0.6; // VARIANT B: buy only deeper dips, now at <= 60% of
// the peak (was 0.7) — entry nearer the bottom, smaller average drawdown.
const ENTRY_LAST_FIRST_MAX = 1.4; // and <= 1.4x its first price
const ENTRY_BUY_SHARE_MIN = 0.6; // >= 60% buys in the last 10 trades
const STOP_LOSS = 0.88; // sell at -12% vs entry cost basis
const TRAIL_ARM = 1.5; // trailing stop arms at +50%
const TRAIL_DROP = 0.7; // sell at 30% below the peak once armed (variant A at 0.6
// graded WORSE: -0.03805 SOL vs -0.02728 SOL — reverted)
const TIME_STOP_SLOTS = 1800; // ~12 min without arming -> exit
const BUY_SLIPPAGE_BPS = 2000; // 20%: do not chase a vertical spike
const SELL_SLIPPAGE_BPS = 10000; // sells must never be rejected on slippage
const TX_FEE_LAMPORTS = 105_000n; // base 5,000 + priority 100,000

// ---- Per-mint tape state (built from the batch events) ----
type MintState = {
  firstPrice: number;
  peakPrice: number;
  lastPrice: number;
  lastRq: bigint;
  tradeCount: number;
  // Last 10 trades: quote lamports, isBuy.
  recent: { q: bigint; isBuy: boolean }[];
};

type TrackedPosition = {
  tokens: bigint;
  cost: bigint;
  entrySlot: number;
  peak: number; // best return ratio seen (0 until the first decision)
  armed: boolean;
};

const mints = new Map<string, MintState>();
const tracked = new Map<string, TrackedPosition>();
// One entry per mint EVER: v3 re-bought the same losers after each full sell,
// so a single bad coin could lose 2-3x the buy size.
const entered = new Set<string>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt); // lamports per token (ratio only; scale cancels)
}

function onEvent(ev: Batch["events"][number]): void {
  const mint = ev.mint;
  if (ev.event === "CreateEvent") {
    const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
    mints.set(mint, {
      firstPrice: p,
      peakPrice: p,
      lastPrice: p,
      lastRq: 0n, // CreateEvent carries no real_quote_reserves: 0 SOL in yet
      tradeCount: 0,
      recent: [],
    });
    return;
  }
  if (ev.event !== "TradeEvent") return; // CompleteEvent: nothing to track
  let m = mints.get(mint);
  if (!m) {
    // Trade before we saw the create (dataset boundary): seed from the trade.
    const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
    m = {
      firstPrice: p,
      peakPrice: p,
      lastPrice: p,
      lastRq: BigInt(ev.real_quote_reserves),
      tradeCount: 0,
      recent: [],
    };
    mints.set(mint, m);
  }
  const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
  m.lastPrice = p;
  if (p > m.peakPrice) m.peakPrice = p;
  m.lastRq = BigInt(ev.real_quote_reserves);
  m.tradeCount += 1;
  const q = BigInt(ev.quote_amount); // protocol field (NOT quote_lamports)
  m.recent.push({ q, isBuy: ev.is_buy });
  if (m.recent.length > 10) m.recent.shift();
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const slot = batch.slot;
  const orders: OrderInput[] = [];

  // 1. Fold this batch's events into the per-mint tape.
  for (const ev of batch.events) onEvent(ev);

  // 2. Sync tracked positions from the harness account (authoritative).
  //    A position first seen here entered at this slot (its buy filled).
  const seen = new Set<string>();
  for (const [mint, holding] of state.positions) {
    seen.add(mint);
    const prev = tracked.get(mint);
    if (prev) {
      prev.tokens = holding.token_amount;
      prev.cost = holding.cost_lamports;
    } else {
      tracked.set(mint, {
        tokens: holding.token_amount,
        cost: holding.cost_lamports,
        entrySlot: slot,
        peak: 0,
        armed: false,
      });
    }
  }
  for (const mint of [...tracked.keys()]) {
    if (!seen.has(mint)) tracked.delete(mint);
  }

  // Mints with a sell already in flight: do not send a second sell.
  const sellPending = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === "sell") sellPending.add(p.order.mint);
  }

  // 3. Exits first (free a slot before considering entries).
  for (const [mint, pos] of tracked) {
    if (sellPending.has(mint)) continue;
    const m = mints.get(mint);
    const mp = m ? m.lastPrice : 0;
    if (mp <= 0 || pos.tokens <= 0n || pos.cost <= 0n) continue;
    const entryPrice = Number(pos.cost) / Number(pos.tokens);
    if (entryPrice <= 0) continue;
    const ret = mp / entryPrice;
    if (ret > pos.peak) pos.peak = ret;
    if (!pos.armed && ret >= TRAIL_ARM) pos.armed = true;
    const stopHit = ret <= STOP_LOSS;
    const trailHit = pos.armed && ret <= pos.peak * TRAIL_DROP;
    const timeHit = !pos.armed && slot - pos.entrySlot >= TIME_STOP_SLOTS;
    if (stopHit || trailHit || timeHit) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.tokens,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // 4. Entries: the dip after a proven 2x pump.
  const exiting = orders.length;
  const openNow = state.committedPositionCount() - exiting;
  if (openNow < MAX_OPEN_POSITIONS) {
    for (const [mint, m] of mints) {
      if (openNow + orders.length >= MAX_OPEN_POSITIONS) break;
      if (tracked.has(mint)) continue;
      if (entered.has(mint)) continue; // never re-enter a mint, win or lose
      if (m.tradeCount < ENTRY_MIN_TRADES) continue;
      if (m.lastRq < MIN_REAL_RESERVES_LAMPORTS) continue;
      if (m.firstPrice <= 0) continue;
      // The coin proved it can run: peaked >= 2x its first price...
      if (m.peakPrice / m.firstPrice < ENTRY_PEAK_GAIN) continue;
      // ...and has retraced to <= 70% of the peak and <= 1.4x the first price.
      if (m.lastPrice / m.peakPrice > ENTRY_RETRACE_MAX) continue;
      if (m.lastPrice / m.firstPrice > ENTRY_LAST_FIRST_MAX) continue;
      // Fresh buy flow returning over the last 10 trades (not a dead coin).
      let buyQ = 0n;
      let totalQ = 0n;
      for (const t of m.recent) {
        totalQ += t.q;
        if (t.isBuy) buyQ += t.q;
      }
      if (totalQ <= 0n || Number(buyQ) / Number(totalQ) < ENTRY_BUY_SHARE_MIN) continue;
      // Size: 0.02 SOL, capped at 0.9% of real reserves, floored at 0.01 SOL.
      let size = TARGET_SIZE_LAMPORTS;
      const cap = (m.lastRq * BigInt(MAX_ORDER_RQ_BPS)) / 10000n;
      if (size > cap) size = cap;
      if (size < MIN_SIZE_LAMPORTS) continue;
      if (state.freeCashLamports() < size + TX_FEE_LAMPORTS) continue;
      entered.add(mint);
      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }
  }

  return orders;
}

await runBot({ onBatch });
