// Momentum Strategy — translated from TradingView Pine Script v6
//
// Pine:
//   length = input(12)
//   mom0 = close - close[length]
//   mom1 = mom0 - mom0[1]
//   if (mom0 > 0 and mom1 > 0)
//     strategy.entry("MomLE", long,  stop=high+mintick)
//   else
//     strategy.cancel("MomLE")
//   if (mom0 < 0 and mom1 < 0)
//     strategy.entry("MomSE", short, stop=low-mintick)
//   else
//     strategy.cancel("MomSE")
//
// Entry type: STOP ORDER (placed on bar N, can fill on bar N+1 in this app's convention)

const BTCUSDT_MINTICK = 1;
const PRICE_EPS = 1e-9;

function computeMom0(candles, i, length) {
  if (i < length) return null;
  return candles[i].close - candles[i - length].close;
}

export const MomentumStrategy = {
  id: "momentum",
  name: "Momentum Strategy",

  paramSchema: {
    length: { type: "number", label: "Length", default: 12, min: 1, max: 1000 },
  },

  generateSignals(candles, { length }) {
    const signals = [];
    const TICK = BTCUSDT_MINTICK;

    // Pending stop orders computed from previous bar (and cancelable)
    let pendingLongStop = null;  // number | null
    let pendingShortStop = null; // number | null

    // Keep previous mom0 for mom1 calculation
    let prevMom0 = null;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // ── STEP 1: Execute pending stop orders (from bar i-1) ──────────────────
      if (i > 0) {
        const longHit = pendingLongStop != null && bar.high >= pendingLongStop - PRICE_EPS;
        const shortHit = pendingShortStop != null && bar.low <= pendingShortStop + PRICE_EPS;

        if (longHit || shortHit) {
          let chosen = null;
          if (longHit && shortHit) {
            // User-chosen rule: resolve ambiguity by candle bias
            chosen = bar.close >= bar.open ? "long" : "short";
          } else {
            chosen = longHit ? "long" : "short";
          }

          if (chosen === "long") {
            const entryPrice = bar.open > pendingLongStop ? bar.open : pendingLongStop;
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "long",
              label: "MomLE",
              entryPrice,
              stopLevel: pendingLongStop - TICK,
            });
          } else {
            const entryPrice = bar.open < pendingShortStop ? bar.open : pendingShortStop;
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "short",
              label: "MomSE",
              entryPrice,
              stopLevel: pendingShortStop + TICK,
            });
          }
        }
      }

      // ── STEP 2: Compute momentum and arm/cancel stops for next bar ──────────
      const mom0 = computeMom0(candles, i, length);
      const mom1 = mom0 != null && prevMom0 != null ? mom0 - prevMom0 : null;

      const longCond = mom0 != null && mom1 != null && mom0 > 0 && mom1 > 0;
      const shortCond = mom0 != null && mom1 != null && mom0 < 0 && mom1 < 0;

      // Pine cancels each side independently when condition is false
      pendingLongStop = longCond ? bar.high + TICK : null;
      pendingShortStop = shortCond ? bar.low - TICK : null;

      prevMom0 = mom0;
    }

    return signals;
  },

  getPendingLevels(candles, { length }) {
    if (!candles.length) return { buy: null, sell: null };
    if (candles.length <= length + 1) return { buy: null, sell: null };

    const TICK = BTCUSDT_MINTICK;
    const i = candles.length - 1;
    const mom0 = computeMom0(candles, i, length);
    const prevMom0 = computeMom0(candles, i - 1, length);
    const mom1 = mom0 != null && prevMom0 != null ? mom0 - prevMom0 : null;

    const longCond = mom0 != null && mom1 != null && mom0 > 0 && mom1 > 0;
    const shortCond = mom0 != null && mom1 != null && mom0 < 0 && mom1 < 0;

    const last = candles[i];
    return {
      buy: longCond ? last.high + TICK : null,
      sell: shortCond ? last.low - TICK : null,
    };
  },
};

