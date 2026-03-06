// Pivot Reversal RSI Strategy — "Pivot Point Reversal + RSI Strategy"
// Translated from Pine Script @version=4
//
// Difference from basic Pivot Reversal:
//   RSI filter gates stop order arming at pivot detection:
//   - Long only if RSI at pivot bar < rsiLong (not yet overbought)
//   - Short only if RSI at pivot bar > rsiShort (not yet oversold)
//
// Note: Pine Script has a bug — rsi_length is declared as input but
//   rsi(close, 14) uses hardcoded 14. We use rsiLength param as intended.

const BTCUSDT_MINTICK = 0.1;

// ── RSI Helper (Wilder's RMA) ──────────────────────────────────────────────────
// Pine Script's rsi(source, length):
//   u = max(close - prevClose, 0), d = max(prevClose - close, 0)
//   avgU = rma(u, length), avgD = rma(d, length)
//   RSI = 100 - 100 / (1 + avgU/avgD)
// Seed (bar length-1): SMA; subsequent: (prev*(length-1) + x) / length
function calcRSI(candles, length) {
  const rsi = new Array(candles.length).fill(null);
  if (candles.length < length) return rsi; // guard: not enough data
  const u = [], d = [];
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    const change = candles[i].close - prevClose;
    u.push(change > 0 ? change : 0);
    d.push(change < 0 ? -change : 0);
  }
  // Seed: SMA of first `length` values (u[0]..u[length-1])
  let avgU = u.slice(0, length).reduce((s, v) => s + v, 0) / length;
  let avgD = d.slice(0, length).reduce((s, v) => s + v, 0) / length;
  rsi[length - 1] = avgD === 0 ? 100 : 100 - 100 / (1 + avgU / avgD);
  // Subsequent: RMA (Wilder's smoothing)
  for (let i = length; i < candles.length; i++) {
    avgU = (avgU * (length - 1) + u[i]) / length;
    avgD = (avgD * (length - 1) + d[i]) / length;
    rsi[i] = avgD === 0 ? 100 : 100 - 100 / (1 + avgU / avgD);
  }
  return rsi;
}

// ── Pivot High Detection (same as pivotReversal.js) ───────────────────────────
function getPivotHigh(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;
  const pivotHigh = candles[pivotIdx].high;
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].high >= pivotHigh) return null;
  }
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].high >= pivotHigh) return null;
  }
  return pivotHigh;
}

// ── Pivot Low Detection (same as pivotReversal.js) ────────────────────────────
function getPivotLow(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;
  const pivotLow = candles[pivotIdx].low;
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].low <= pivotLow) return null;
  }
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].low <= pivotLow) return null;
  }
  return pivotLow;
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PivotReversalRsiStrategy = {
  id: "pivot-reversal-rsi",
  name: "Pivot Reversal RSI Strategy",

  paramSchema: {
    leftBars:  { type: "number", label: "Left Bars",      default: 3,  min: 1, max: 50  },
    rightBars: { type: "number", label: "Right Bars",     default: 3,  min: 1, max: 50  },
    rsiLength: { type: "number", label: "RSI Length",     default: 14, min: 2, max: 100 },
    rsiLong:   { type: "number", label: "RSI Overbought", default: 70, min: 1, max: 100 },
    rsiShort:  { type: "number", label: "RSI Oversold",   default: 30, min: 0, max: 99  },
  },

  generateSignals(candles, { leftBars, rightBars, rsiLength, rsiLong, rsiShort }) {
    const TICK = BTCUSDT_MINTICK;
    const rsiArr = calcRSI(candles, rsiLength);
    const signals = [];

    let hprice = 0; // last pivot high price
    let le = false; // long stop order armed
    let lprice = 0; // last pivot low price
    let se = false; // short stop order armed

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // ── STEP 1: Execute pending stop orders ──────────────────────────────────
      if (i > 0) {
        if (le && hprice > 0 && bar.high >= hprice + TICK) {
          const stopPrice = hprice + TICK;
          signals.push({
            barIndex: i,
            time: bar.time,
            timestamp: bar.timestamp,
            type: "long",
            label: "PivRSI Long",
            entryPrice: bar.open > stopPrice ? bar.open : stopPrice,
            stopLevel: hprice,
          });
          le = false;
        }
        if (se && lprice > 0 && bar.low <= lprice - TICK) {
          const stopPrice = lprice - TICK;
          signals.push({
            barIndex: i,
            time: bar.time,
            timestamp: bar.timestamp,
            type: "short",
            label: "PivRSI Short",
            entryPrice: bar.open < stopPrice ? bar.open : stopPrice,
            stopLevel: lprice,
          });
          se = false;
        }
      }

      // ── STEP 2: Detect pivots ─────────────────────────────────────────────
      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);

      // ── STEP 3: Update hprice/le WITH RSI gate ────────────────────────────
      // Pine: le := swh_cond ? true : (le[1] and high > hprice ? false : le[1])
      // Pine: if (le and rsi[rightBars] < rsi_long) strategy.entry(...)
      // rsi[rightBars] at bar i = RSI at pivotIdx = rsiArr[i - rightBars]
      if (swh !== null) {
        hprice = swh;
        const rsiAtPivot = rsiArr[i - rightBars]; // rsi[rightBars] in Pine
        le = rsiAtPivot === null || rsiAtPivot < rsiLong;
      } else if (le && bar.high > hprice) {
        le = false; // disarm: price crossed pivot high without triggering stop
      }

      // ── STEP 4: Update lprice/se WITH RSI gate ────────────────────────────
      if (swl !== null) {
        lprice = swl;
        const rsiAtPivot = rsiArr[i - rightBars];
        se = rsiAtPivot === null || rsiAtPivot > rsiShort;
      } else if (se && bar.low < lprice) {
        se = false; // disarm: price crossed pivot low without triggering stop
      }
    }

    return signals;
  },
};
