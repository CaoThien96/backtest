// Channel BreakOut Strategy — translated from TradingView Pine Script v6
//
// Pine:
//   length = input.int(defval=5)
//   upBound = ta.highest(high, length)
//   downBound = ta.lowest(low, length)
//   if (not na(close[length]))
//     strategy.entry("ChBrkLE", long,  stop=upBound + mintick)
//   strategy.entry("ChBrkSE", short, stop=downBound - mintick)
//
// Entry type: STOP ORDER (placed at bar N, can fill on bar N+1 in this app's convention)

const BTCUSDT_MINTICK = 1;
const PRICE_EPS = 1e-9;

function highestHigh(candles, endIdx, length) {
  const start = endIdx - length + 1;
  let hh = -Infinity;
  for (let i = start; i <= endIdx; i++) hh = Math.max(hh, candles[i].high);
  return hh;
}

function lowestLow(candles, endIdx, length) {
  const start = endIdx - length + 1;
  let ll = Infinity;
  for (let i = start; i <= endIdx; i++) ll = Math.min(ll, candles[i].low);
  return ll;
}

export const ChannelBreakoutStrategy = {
  id: "channel-breakout",
  name: "Channel BreakOut Strategy",

  paramSchema: {
    length: { type: "number", label: "Length", default: 5, min: 1, max: 1000 },
  },

  generateSignals(candles, { length }) {
    const signals = [];
    const TICK = BTCUSDT_MINTICK;

    // Pending stop orders computed from previous bar's channel
    let upperStop = null;
    let lowerStop = null;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // ── STEP 1: Execute pending stop orders (from bar i-1) ──────────────────
      if (i > 0 && upperStop != null && lowerStop != null) {
        const longHit = bar.high >= upperStop - PRICE_EPS;
        const shortHit = bar.low <= lowerStop + PRICE_EPS;

        if (longHit || shortHit) {
          let type;
          if (longHit && shortHit) {
            // User-chosen rule: resolve ambiguity by candle bias
            type = bar.close >= bar.open ? "long" : "short";
          } else {
            type = longHit ? "long" : "short";
          }

          if (type === "long") {
            const entryPrice = bar.open > upperStop ? bar.open : upperStop;
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "long",
              label: "ChBrkLE",
              entryPrice,
              stopLevel: upperStop - TICK,
            });
          } else {
            const entryPrice = bar.open < lowerStop ? bar.open : lowerStop;
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "short",
              label: "ChBrkSE",
              entryPrice,
              stopLevel: lowerStop + TICK,
            });
          }
        }
      }

      // ── STEP 2: Update channel bounds on bar i (arm for next bar) ───────────
      if (i >= length) {
        const upBound = highestHigh(candles, i, length);
        const downBound = lowestLow(candles, i, length);
        upperStop = upBound + TICK;
        lowerStop = downBound - TICK;
      } else {
        upperStop = null;
        lowerStop = null;
      }
    }

    return signals;
  },

  getPendingLevels(candles, { length }) {
    if (!candles.length) return { buy: null, sell: null };
    if (candles.length <= length) return { buy: null, sell: null };

    const TICK = BTCUSDT_MINTICK;
    const lastIdx = candles.length - 1;
    const upBound = highestHigh(candles, lastIdx, length);
    const downBound = lowestLow(candles, lastIdx, length);
    return { buy: upBound + TICK, sell: downBound - TICK };
  },
};

