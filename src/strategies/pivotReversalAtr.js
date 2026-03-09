// Pivot Reversal ATR Strategy — "Significant Pivot Reversal Strategy" (SPPS)
// Translated from Pine Script by QuantNomad (@version=4)
//
// Difference from basic Pivot Reversal:
//   Uses ATR significance filter — pivot must exceed surrounding bars by
//   at least (atr * atrMult) instead of just being strictly greater.
//
// Entry logic (hprice/le/lprice/se state machine + stop orders) is identical
// to pivotReversal.js.

const BTCUSDT_MINTICK = 0.1;

// ── ATR Helper (Wilder's RMA) ─────────────────────────────────────────────────
// Returns array of ATR values per candle (null until seed bar is reached)
// Pine Script's atr() = RMA of True Range:
//   Seed (bar length-1): SMA(TR, length)
//   Subsequent: (prevATR * (length - 1) + TR) / length
function calcATR(candles, length) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (i < length - 1) { sum += tr; }
    else if (i === length - 1) { sum += tr; atr[i] = sum / length; } // seed SMA
    else { atr[i] = (atr[i - 1] * (length - 1) + tr) / length; }    // RMA
  }
  return atr;
}

// ── Pivot High Significant ────────────────────────────────────────────────────
// Pine Script: pivotHighSig(left, right)
//   for i = 1 to left:    if high[right] < high[right+i] + atr*atrMult → fail
//   for i = 0 to right-1: if high[right] < high[i]       + atr*atrMult → fail
//
// Indexing translation (current bar = i, pivotIdx = i - rightBars):
//   high[right+j] = candles[pivotIdx - j]  (j = 1..leftBars)
//   high[j]       = candles[i - j]         = candles[pivotIdx + (rightBars - j)]
//                 → candles[pivotIdx + k]   (k = 1..rightBars, reverse order, same set)
function getPivotHighSig(candles, i, leftBars, rightBars, atrArr, atrMult) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;
  const threshold = (atrArr[i] ?? 0) * atrMult;
  const pivotHigh = candles[pivotIdx].high;
  // Left bars: candles[pivotIdx-1] .. candles[pivotIdx-leftBars]
  for (let j = 1; j <= leftBars; j++) {
    if (pivotHigh < candles[pivotIdx - j].high + threshold) return null;
  }
  // Right bars: candles[pivotIdx+1] .. candles[pivotIdx+rightBars] (= candles[i])
  for (let j = 1; j <= rightBars; j++) {
    if (pivotHigh < candles[pivotIdx + j].high + threshold) return null;
  }
  return pivotHigh;
}

// ── Pivot Low Significant ─────────────────────────────────────────────────────
// Pine Script: pivotLowSig(left, right)
//   for i = 1 to left:    if low[right] > low[right+i] - atr*atrMult → fail
//   for i = 0 to right-1: if low[right] > low[i]       - atr*atrMult → fail
function getPivotLowSig(candles, i, leftBars, rightBars, atrArr, atrMult) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;
  const threshold = (atrArr[i] ?? 0) * atrMult;
  const pivotLow = candles[pivotIdx].low;
  // Left bars
  for (let j = 1; j <= leftBars; j++) {
    if (pivotLow > candles[pivotIdx - j].low - threshold) return null;
  }
  // Right bars
  for (let j = 1; j <= rightBars; j++) {
    if (pivotLow > candles[pivotIdx + j].low - threshold) return null;
  }
  return pivotLow;
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PivotReversalAtrStrategy = {
  id: "pivot-reversal-atr",
  name: "Pivot Reversal ATR Strategy",

  paramSchema: {
    leftBars:  { type: "number", label: "Left Bars",  default: 3,   min: 1, max: 50  },
    rightBars: { type: "number", label: "Right Bars", default: 3,   min: 1, max: 50  },
    atrLength: { type: "number", label: "ATR Length", default: 14,  min: 1, max: 100 },
    atrMult:   { type: "number", label: "ATR Mult",   default: 0.1, min: 0, max: 5, step: 0.1 },
  },

  generateSignals(candles, { leftBars, rightBars, atrLength, atrMult }) {
    const TICK = BTCUSDT_MINTICK;
    const atrArr = calcATR(candles, atrLength);
    const signals = [];

    let hprice = 0; // last significant pivot high
    let le = false; // long stop order armed
    let lprice = 0; // last significant pivot low
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
            label: "PivRevLE",
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
            label: "PivRevSE",
            entryPrice: bar.open < stopPrice ? bar.open : stopPrice,
            stopLevel: lprice,
          });
          se = false;
        }
      }

      // ── STEP 2: Detect ATR-significant pivots ─────────────────────────────
      const swh = getPivotHighSig(candles, i, leftBars, rightBars, atrArr, atrMult);
      const swl = getPivotLowSig(candles, i, leftBars, rightBars, atrArr, atrMult);

      // ── STEP 3: Update hprice/le (Pine Script state machine) ──────────────
      // hprice := swh_cond ? swh : hprice[1]
      // le := swh_cond ? true : (le[1] and high > hprice ? false : le[1])
      if (swh !== null) { hprice = swh; le = true; }
      else if (le && bar.high > hprice) { le = false; }

      // ── STEP 4: Update lprice/se ──────────────────────────────────────────
      if (swl !== null) { lprice = swl; se = true; }
      else if (se && bar.low < lprice) { se = false; }
    }

    return signals;
  },

  getPendingLevels(candles, { leftBars, rightBars, atrLength, atrMult }) {
    if (!candles.length) return { buy: null, sell: null };
    const TICK = BTCUSDT_MINTICK;
    const atrArr = calcATR(candles, atrLength);
    let hprice = 0, le = false, lprice = 0, se = false;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      if (i > 0) {
        if (le && hprice > 0 && bar.high >= hprice + TICK) le = false;
        if (se && lprice > 0 && bar.low <= lprice - TICK) se = false;
      }
      const swh = getPivotHighSig(candles, i, leftBars, rightBars, atrArr, atrMult);
      const swl = getPivotLowSig(candles, i, leftBars, rightBars, atrArr, atrMult);
      if (swh !== null) { hprice = swh; le = true; }
      else if (le && bar.high > hprice) le = false;
      if (swl !== null) { lprice = swl; se = true; }
      else if (se && bar.low < lprice) se = false;
    }

    return {
      buy:  le && hprice > 0 ? hprice + TICK : null,
      sell: se && lprice > 0 ? lprice - TICK : null,
    };
  },
};
