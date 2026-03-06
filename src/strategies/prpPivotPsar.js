// PRP - Pivot Reversal + PSAR Strategy
// Reconstructed from QuantNomad's PRP Pine Script (@version=5)
//
// Core logic:
//   - Pivot LOW near support zone → arm long → breakout above pivot HIGH → entry
//   - Pivot HIGH near resistance zone → arm short → breakout below pivot LOW → entry
//   - Standard Pivot Point levels (Daily, computed from 15m candles) for zone confirmation
//   - Exit: ATR-based SL/TP + optional PSAR trailing stop (per-bar dynamic, via exitFn)

const BTCUSDT_MINTICK = 0.1;

// ── ATR Helper (Wilder's RMA) ─────────────────────────────────────────────────
function calcATR(candles, length) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (i < length - 1)      { sum += tr; }
    else if (i === length - 1) { sum += tr; atr[i] = sum / length; }
    else                       { atr[i] = (atr[i - 1] * (length - 1) + tr) / length; }
  }
  return atr;
}

// ── Parabolic SAR ─────────────────────────────────────────────────────────────
// Translates Pine's ta.sar(start, increment, maximum).
// result[i] = SAR value after bar i closes (available before bar i+1 opens).
function calcPSAR(candles, start, increment, maximum) {
  const n = candles.length;
  const result = new Array(n).fill(null);
  if (n < 3) return result;

  let isLong = candles[1].close >= candles[0].close;
  let af     = start;
  let ep     = isLong ? candles[0].high : candles[0].low;
  let sarVal = isLong
    ? Math.min(candles[0].low, candles[1].low)
    : Math.max(candles[0].high, candles[1].high);

  result[0] = sarVal;
  result[1] = sarVal;

  for (let i = 2; i < n; i++) {
    const { high, low } = candles[i];
    const p1h = candles[i - 1].high, p1l = candles[i - 1].low;
    const p2h = candles[i - 2].high, p2l = candles[i - 2].low;

    let newSAR = sarVal + af * (ep - sarVal);

    if (isLong) {
      newSAR = Math.min(newSAR, p1l, p2l); // SAR cannot be above 2 prior lows
      if (low <= newSAR) {                  // flip to bearish
        isLong = false;
        newSAR = ep;
        ep     = low;
        af     = start;
        newSAR = Math.max(newSAR, p1h, p2h);
      } else if (high > ep) {
        ep = high;
        af = Math.min(af + increment, maximum);
      }
    } else {
      newSAR = Math.max(newSAR, p1h, p2h); // SAR cannot be below 2 prior highs
      if (high >= newSAR) {                 // flip to bullish
        isLong = true;
        newSAR = ep;
        ep     = high;
        af     = start;
        newSAR = Math.min(newSAR, p1l, p2l);
      } else if (low < ep) {
        ep = low;
        af = Math.min(af + increment, maximum);
      }
    }

    sarVal  = newSAR;
    result[i] = sarVal;
  }
  return result;
}

// ── Daily Pivot Point Levels ──────────────────────────────────────────────────
// Aggregates 15m candles into UTC daily bars, computes PP levels from PREVIOUS
// day's H/L/C (no lookahead). Returns per-candle array of level objects.
function computeDailyPivotLevels(candles, ppType) {
  const days = new Map(); // UTC dayKey → { high, low, close, firstIdx }
  for (let i = 0; i < candles.length; i++) {
    const key = Math.floor(candles[i].timestamp / 86400000);
    if (!days.has(key)) {
      days.set(key, { high: candles[i].high, low: candles[i].low, close: candles[i].close, firstIdx: i });
    } else {
      const d = days.get(key);
      d.high  = Math.max(d.high, candles[i].high);
      d.low   = Math.min(d.low,  candles[i].low);
      d.close = candles[i].close; // last candle of day
    }
  }

  const dayKeys = [...days.keys()].sort((a, b) => a - b);
  const result  = new Array(candles.length).fill(null);

  for (let d = 1; d < dayKeys.length; d++) {
    const { high: H, low: L, close: C } = days.get(dayKeys[d - 1]);
    const range = H - L;
    let levels;

    switch (ppType) {
      case "Fibonacci": {
        const pp = (H + L + C) / 3;
        levels = { pp, r1: pp + 0.382 * range, r2: pp + 0.618 * range, r3: pp + range,
                        s1: pp - 0.382 * range, s2: pp - 0.618 * range, s3: pp - range };
        break;
      }
      case "Woodie": {
        const pp = (H + L + 2 * C) / 4;
        levels = { pp, r1: 2 * pp - L, r2: pp + range, r3: H + 2 * (pp - L),
                        s1: 2 * pp - H, s2: pp - range, s3: L - 2 * (H - pp) };
        break;
      }
      case "Camarilla": {
        const pp = (H + L + C) / 3;
        levels = { pp,
          r1: C + range * 1.1 / 12, r2: C + range * 1.1 / 6, r3: C + range * 1.1 / 4,
          s1: C - range * 1.1 / 12, s2: C - range * 1.1 / 6, s3: C - range * 1.1 / 4 };
        break;
      }
      default: { // Standard
        const pp = (H + L + C) / 3;
        levels = { pp, r1: 2 * pp - L, r2: pp + range, r3: pp + 2 * range,
                        s1: 2 * pp - H, s2: pp - range, s3: pp - 2 * range };
        break;
      }
    }

    const curr        = days.get(dayKeys[d]);
    const nextFirstIdx = d + 1 < dayKeys.length ? days.get(dayKeys[d + 1]).firstIdx : candles.length;
    for (let i = curr.firstIdx; i < nextFirstIdx; i++) result[i] = levels;
  }

  return result;
}

// ── Pivot Detection ───────────────────────────────────────────────────────────
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

// ── Zone Confirmation ─────────────────────────────────────────────────────────
function isNearSupport(price, levels, ppLevels, zonePct) {
  if (!levels) return true; // no daily data → pass filter
  const w = price * zonePct / 100;
  const pts = [levels.pp, levels.s1];
  if (ppLevels >= 2) pts.push(levels.s2);
  if (ppLevels >= 3) pts.push(levels.s3);
  return pts.some(p => Math.abs(price - p) <= w);
}

function isNearResistance(price, levels, ppLevels, zonePct) {
  if (!levels) return true;
  const w = price * zonePct / 100;
  const pts = [levels.pp, levels.r1];
  if (ppLevels >= 2) pts.push(levels.r2);
  if (ppLevels >= 3) pts.push(levels.r3);
  return pts.some(p => Math.abs(price - p) <= w);
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PrpPivotPsarStrategy = {
  id: "prp-pivot-psar",
  name: "PRP - Pivot Reversal - PSAR Strategy",

  paramSchema: {
    leftBars:     { type: "number", label: "Left Bars",     default: 3,   min: 1,    max: 50              },
    rightBars:    { type: "number", label: "Right Bars",    default: 3,   min: 1,    max: 50              },
    ppType:       { type: "select", label: "PP Type",       default: "Woodie", options: ["Standard", "Fibonacci", "Woodie", "Camarilla"] },
    ppLevels:     { type: "number", label: "PP Levels",     default: 1,    min: 1,    max: 3               },
    atrPeriod:    { type: "number", label: "ATR Period",    default: 14,   min: 1,    max: 100             },
    slMultiplier: { type: "number", label: "SL ATR Mult",   default: 3.0,  min: 0.1,  max: 20,  step: 0.1 },
    tpMultiplier: { type: "number", label: "TP ATR Mult",   default: 9.0, min: 0.1,  max: 50,  step: 0.1 },
    usePSAR:      { type: "select", label: "PSAR Trailing", default: "No", options: ["Yes", "No"]         },
    psarStart:    { type: "number", label: "PSAR Start",    default: 0.05, min: 0.001, max: 0.5, step: 0.01 },
    psarInc:      { type: "number", label: "PSAR Inc",      default: 0.01, min: 0.001, max: 0.5, step: 0.01 },
    psarMax:      { type: "number", label: "PSAR Max",      default: 0.2,  min: 0.01,  max: 1.0, step: 0.01 },
    useZoneFilter:{ type: "select", label: "Zone Filter",   default: "Yes", options: ["Yes", "No"]         },
    zonePct:      { type: "number", label: "Zone Width %",  default: 2.6,  min: 0.1,   max: 5,   step: 0.1 },
    tradeDir:     { type: "select", label: "Direction",     default: "Both", options: ["Long", "Short", "Both"] },
  },

  generateSignals(candles, {
    leftBars, rightBars,
    ppType, ppLevels,
    atrPeriod, slMultiplier, tpMultiplier,
    usePSAR, psarStart, psarInc, psarMax,
    useZoneFilter, zonePct,
    tradeDir,
  }) {
    const TICK = BTCUSDT_MINTICK;

    // Precompute indicator arrays
    const atrArr      = calcATR(candles, atrPeriod);
    const psarArr     = calcPSAR(candles, psarStart, psarInc, psarMax);
    const pivotLevels = computeDailyPivotLevels(candles, ppType);

    const psarEnabled      = usePSAR      === "Yes";
    const zoneFilterEnabled = useZoneFilter === "Yes";
    const canLong  = tradeDir === "Both" || tradeDir === "Long";
    const canShort = tradeDir === "Both" || tradeDir === "Short";

    // exitFn factory: closes over indicator arrays + params + entry details
    const makeExitFn = (type, entryPrice) => (bar, barIndex) => {
      const atr  = atrArr[barIndex];
      const psar = psarArr[barIndex];
      if (!atr) return null;

      if (type === "long") {
        const fixedSL    = entryPrice - atr * slMultiplier;
        const tp         = entryPrice + atr * tpMultiplier;
        const usePsarNow = psarEnabled && psar !== null && psar < bar.close;
        const effectiveSL = usePsarNow ? Math.max(fixedSL, psar) : fixedSL;
        if (bar.low  <= effectiveSL) return { exitPrice: Math.min(bar.open, effectiveSL), exitSignal: "Stop Loss",   timestamp: bar.timestamp };
        if (bar.high >= tp)          return { exitPrice: Math.max(bar.open, tp),           exitSignal: "Take Profit", timestamp: bar.timestamp };
      } else {
        const fixedSL    = entryPrice + atr * slMultiplier;
        const tp         = entryPrice - atr * tpMultiplier;
        const usePsarNow = psarEnabled && psar !== null && psar > bar.close;
        const effectiveSL = usePsarNow ? Math.min(fixedSL, psar) : fixedSL;
        if (bar.high >= effectiveSL) return { exitPrice: Math.max(bar.open, effectiveSL), exitSignal: "Stop Loss",   timestamp: bar.timestamp };
        if (bar.low  <= tp)          return { exitPrice: Math.min(bar.open, tp),           exitSignal: "Take Profit", timestamp: bar.timestamp };
      }
      return null;
    };

    const signals = [];
    let hprice = 0;    // last pivot high (entry trigger for longs)
    let lprice = 0;    // last pivot low  (entry trigger for shorts)
    let longArmed  = false;
    let shortArmed = false;

    for (let i = 0; i < candles.length; i++) {
      const bar    = candles[i];
      const levels = pivotLevels[i];

      // ── STEP 1: Execute pending stop orders ────────────────────────────────
      if (i > 0) {
        if (longArmed && hprice > 0 && bar.high >= hprice + TICK) {
          const stopPrice = hprice + TICK;
          const entryPrice = bar.open > stopPrice ? bar.open : stopPrice;
          if (canLong) {
            signals.push({
              barIndex:   i,
              time:       bar.time,
              timestamp:  bar.timestamp,
              type:       "long",
              label:      "PRP Long",
              entryPrice,
              stopLevel:  hprice,
              exitFn:     makeExitFn("long", entryPrice),
            });
          }
          longArmed = false;
        }
        if (shortArmed && lprice > 0 && bar.low <= lprice - TICK) {
          const stopPrice = lprice - TICK;
          const entryPrice = bar.open < stopPrice ? bar.open : stopPrice;
          if (canShort) {
            signals.push({
              barIndex:   i,
              time:       bar.time,
              timestamp:  bar.timestamp,
              type:       "short",
              label:      "PRP Short",
              entryPrice,
              stopLevel:  lprice,
              exitFn:     makeExitFn("short", entryPrice),
            });
          }
          shortArmed = false;
        }
      }

      // ── STEP 2: Detect pivots ───────────────────────────────────────────────
      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);

      // ── STEP 3: Update hprice / lprice ─────────────────────────────────────
      if (swh !== null) hprice = swh;
      if (swl !== null) lprice = swl;

      // ── STEP 4: Update arming state ─────────────────────────────────────────
      // Pine: longArmed := swl_cond and longZoneOk ? true : (longArmed and high > hprice ? false : longArmed)
      if (swl !== null) {
        const zoneOk = !zoneFilterEnabled || isNearSupport(lprice, levels, ppLevels, zonePct);
        if (zoneOk) {
          longArmed = true;
        } else if (longArmed && bar.high > hprice) {
          longArmed = false;
        }
      } else if (longArmed && bar.high > hprice) {
        longArmed = false;
      }

      // Pine: shortArmed := swh_cond and shortZoneOk ? true : (shortArmed and low < lprice ? false : shortArmed)
      if (swh !== null) {
        const zoneOk = !zoneFilterEnabled || isNearResistance(hprice, levels, ppLevels, zonePct);
        if (zoneOk) {
          shortArmed = true;
        } else if (shortArmed && bar.low < lprice) {
          shortArmed = false;
        }
      } else if (shortArmed && bar.low < lprice) {
        shortArmed = false;
      }
    }

    return signals;
  },
};
