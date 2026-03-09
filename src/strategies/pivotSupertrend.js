// Pivot Point SuperTrend Strategy — translated from LonesomeTheBlue's Pine Script
//
// Core idea:
//   - Build a pivot-based center line from recent pivots.
//   - Construct SuperTrend-style bands (Up/Dn) around center using ATR.
//   - Track Trend (1 or -1) based on price vs bands.
//   - Enter on Trend flips; exit on subsequent Trend flips or optional center-line condition.

const BTCUSDT_MINTICK = 0.1;

// ── ATR Helper (Wilder's RMA) ─────────────────────────────────────────────────
function calcATR(candles, length) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    if (i < length - 1) {
      sum += tr;
    } else if (i === length - 1) {
      sum += tr;
      atr[i] = sum / length;
    } else {
      atr[i] = (atr[i - 1] * (length - 1) + tr) / length;
    }
  }
  return atr;
}

// ── Pivot Detection (left = right = prd) ──────────────────────────────────────
function getPivotHigh(candles, i, prd) {
  const pivotIdx = i - prd;
  if (pivotIdx < prd || pivotIdx + prd >= candles.length) return null;
  const ph = candles[pivotIdx].high;
  // Left side: no higher high
  for (let j = pivotIdx - prd; j < pivotIdx; j++) {
    if (candles[j].high > ph) return null;
  }
  // Right side: strictly lower highs
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].high >= ph) return null;
  }
  return ph;
}

function getPivotLow(candles, i, prd) {
  const pivotIdx = i - prd;
  if (pivotIdx < prd || pivotIdx + prd >= candles.length) return null;
  const pl = candles[pivotIdx].low;
  // Left side: no lower low
  for (let j = pivotIdx - prd; j < pivotIdx; j++) {
    if (candles[j].low < pl) return null;
  }
  // Right side: strictly higher lows
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].low <= pl) return null;
  }
  return pl;
}

export const PivotSupertrendStrategy = {
  id: "pivot-supertrend",
  name: "Pivot Point SuperTrend Strategy",

  paramSchema: {
    prd:        { type: "number", label: "Pivot Period",          default: 2,  min: 1,  max: 50 },
    atrFactor:  { type: "number", label: "ATR Factor",            default: 3,  min: 1,  max: 10, step: 0.1 },
    atrPeriod:  { type: "number", label: "ATR Period",            default: 10, min: 1,  max: 100 },
    useCenter:  { type: "boolean", label: "Use Center Line Exit", default: false },
    minRatePct: { type: "number", label: "Min Profit % for Center Exit", default: 1.0, min: 0, max: 20, step: 0.1 },
    onlyLong:   { type: "boolean", label: "Only Long",            default: false },
  },

  generateSignals(candles, {
    prd,
    atrFactor,
    atrPeriod,
    useCenter,
    minRatePct,
    onlyLong,
  }) {
    const n = candles.length;
    if (n < Math.max(atrPeriod, prd * 2 + 2)) return [];

    const atrArr = calcATR(candles, atrPeriod);

    const center   = new Array(n).fill(null);
    const up       = new Array(n).fill(null);
    const dn       = new Array(n).fill(null);
    const tUp      = new Array(n).fill(null);
    const tDown    = new Array(n).fill(null);
    const trendArr = new Array(n).fill(0);
    const hl2Arr   = new Array(n).fill(null);

    let prevCenter = null;
    let prevTUp = null;
    let prevTDown = null;
    let prevTrend = 1;

    for (let i = 0; i < n; i++) {
      const bar = candles[i];
      const atr = atrArr[i];
      hl2Arr[i] = (bar.high + bar.low) / 2;

      // Pivot-based center update
      const ph = getPivotHigh(candles, i, prd);
      const pl = getPivotLow(candles, i, prd);
      const lastpp = ph != null ? ph : pl != null ? pl : null;
      if (lastpp != null) {
        if (prevCenter == null) prevCenter = lastpp;
        else prevCenter = (prevCenter * 2 + lastpp) / 3;
      }
      center[i] = prevCenter;

      if (atr == null || prevCenter == null) {
        up[i] = dn[i] = tUp[i] = tDown[i] = null;
        trendArr[i] = prevTrend;
        continue;
      }

      up[i] = prevCenter - atrFactor * atr;
      dn[i] = prevCenter + atrFactor * atr;

      if (i === 0) {
        prevTUp = up[i];
        prevTDown = dn[i];
      }

      const prevClose = i > 0 ? candles[i - 1].close : bar.close;

      let currTUp = up[i];
      let currTDown = dn[i];

      if (prevTUp != null) {
        currTUp = prevClose > prevTUp ? Math.max(up[i], prevTUp) : up[i];
      }

      if (prevTDown != null) {
        currTDown = prevClose < prevTDown ? Math.min(dn[i], prevTDown) : dn[i];
      }

      tUp[i] = currTUp;
      tDown[i] = currTDown;

      let trend = prevTrend;
      const prevTUpVal = i > 0 ? tUp[i - 1] : currTUp;
      const prevTDownVal = i > 0 ? tDown[i - 1] : currTDown;

      if (prevTDownVal != null && bar.close > prevTDownVal) trend = 1;
      else if (prevTUpVal != null && bar.close < prevTUpVal) trend = -1;

      trendArr[i] = trend;
      prevTrend = trend;
      prevTUp = currTUp;
      prevTDown = currTDown;
    }

    // Build signals on Trend flips
    const signals = [];

    for (let i = 1; i < n - 1; i++) {
      const prevTrend = trendArr[i - 1];
      const currTrend = trendArr[i];
      if (currTrend === prevTrend) continue;

      const entryIndex = i + 1;
      const entryBar = candles[entryIndex];
      const entryPrice = entryBar.open;

      if (currTrend === 1 && prevTrend === -1) {
        // Long signal
        signals.push({
          barIndex: entryIndex,
          time: entryBar.time,
          timestamp: entryBar.timestamp,
          type: "long",
          label: "PivST Long",
          entryPrice,
          exitFn: (bar, barIndex) => {
            const trendAtEntry = 1;
            if (barIndex <= entryIndex) return null;

            const trendNow = trendArr[barIndex];
            const centerNow = center[barIndex];
            const hl2Now = hl2Arr[barIndex];

            // Center-line early exit (approximate 50% close as full exit)
            if (useCenter && centerNow != null && hl2Now != null) {
              const minRate = minRatePct / 100;
              const price = bar.close;
              if (
                centerNow > hl2Now &&
                price >= entryPrice * (1 + minRate)
              ) {
                return {
                  exitPrice: price,
                  exitSignal: "Center Line Exit",
                  timestamp: bar.timestamp,
                };
              }
            }

            // Trend flip exit
            if (trendNow !== trendAtEntry && trendNow !== 0) {
              return {
                exitPrice: bar.close,
                exitSignal: "Trend Flip",
                timestamp: bar.timestamp,
              };
            }

            return null;
          },
        });
      } else if (currTrend === -1 && prevTrend === 1 && !onlyLong) {
        // Short signal
        signals.push({
          barIndex: entryIndex,
          time: entryBar.time,
          timestamp: entryBar.timestamp,
          type: "short",
          label: "PivST Short",
          entryPrice,
          exitFn: (bar, barIndex) => {
            const trendAtEntry = -1;
            if (barIndex <= entryIndex) return null;

            const trendNow = trendArr[barIndex];
            const centerNow = center[barIndex];
            const hl2Now = hl2Arr[barIndex];

            if (useCenter && centerNow != null && hl2Now != null) {
              const minRate = minRatePct / 100;
              const price = bar.close;
              if (
                centerNow < hl2Now &&
                price <= entryPrice * (1 - minRate)
              ) {
                return {
                  exitPrice: price,
                  exitSignal: "Center Line Exit",
                  timestamp: bar.timestamp,
                };
              }
            }

            if (trendNow !== trendAtEntry && trendNow !== 0) {
              return {
                exitPrice: bar.close,
                exitSignal: "Trend Flip",
                timestamp: bar.timestamp,
              };
            }

            return null;
          },
        });
      }
    }

    return signals;
  },

  getPendingLevels() {
    return { buy: null, sell: null };
  },
};

