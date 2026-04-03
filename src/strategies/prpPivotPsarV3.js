// PRP v3 - Pivot Reversal + PSAR Strategy
// Same as v1, but Direction Confirm (Candle Color / Body Bias) uses the bar *before* breakout (i-1).
// Reconstructed from QuantNomad's PRP Pine Script (@version=5)
//
// Core logic:
//   - Pivot LOW near support zone → arm long → breakout above pivot HIGH → entry
//   - Pivot HIGH near resistance zone → arm short → breakout below pivot LOW → entry
//   - Standard Pivot Point levels (Daily, computed from 15m candles) for zone confirmation
//   - Exit: ATR-based SL/TP (per-bar dynamic, via exitFn)

const BTCUSDT_MINTICK = 0.1;
const PRICE_EPS = 1e-9;

// ── ATR Helper (Wilder's RMA) ─────────────────────────────────────────────────
function calcATR(candles, length) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (i < length - 1) { sum += tr; }
    else if (i === length - 1) { sum += tr; atr[i] = sum / length; }
    else { atr[i] = (atr[i - 1] * (length - 1) + tr) / length; }
  }
  return atr;
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
      d.high = Math.max(d.high, candles[i].high);
      d.low = Math.min(d.low, candles[i].low);
      d.close = candles[i].close; // last candle of day
    }
  }

  const dayKeys = [...days.keys()].sort((a, b) => a - b);
  const result = new Array(candles.length).fill(null);

  for (let d = 1; d < dayKeys.length; d++) {
    const { high: H, low: L, close: C } = days.get(dayKeys[d - 1]);
    const range = H - L;
    let levels;

    switch (ppType) {
      case "Fibonacci": {
        const pp = (H + L + C) / 3;
        levels = {
          pp, r1: pp + 0.382 * range, r2: pp + 0.618 * range, r3: pp + range,
          s1: pp - 0.382 * range, s2: pp - 0.618 * range, s3: pp - range
        };
        break;
      }
      case "Woodie": {
        const pp = (H + L + 2 * C) / 4;
        levels = {
          pp, r1: 2 * pp - L, r2: pp + range, r3: H + 2 * (pp - L),
          s1: 2 * pp - H, s2: pp - range, s3: L - 2 * (H - pp)
        };
        break;
      }
      case "Camarilla": {
        const pp = (H + L + C) / 3;
        levels = {
          pp,
          r1: C + range * 1.1 / 12, r2: C + range * 1.1 / 6, r3: C + range * 1.1 / 4,
          s1: C - range * 1.1 / 12, s2: C - range * 1.1 / 6, s3: C - range * 1.1 / 4
        };
        break;
      }
      default: { // Standard
        const pp = (H + L + C) / 3;
        levels = {
          pp, r1: 2 * pp - L, r2: pp + range, r3: pp + 2 * range,
          s1: 2 * pp - H, s2: pp - range, s3: pp - 2 * range
        };
        break;
      }
    }

    const curr = days.get(dayKeys[d]);
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

// ── Relative Volume (RVOL) Helper ──────────────────────────────────────────────
// RVOL[i] = volume[i] / average(volume[i-lookback..i-1])
function computeRvol(candles, lookback) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (!lookback || lookback <= 0) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {

    const v = candles[i].volume ?? 0;
    if (i < lookback) {
      sum += v;
      continue;
    }
    // sliding window
    sum += v;
    sum -= candles[i - lookback].volume ?? 0;
    const avg = sum / lookback;
    out[i] = avg > 0 ? v / avg : null;
  }
  return out;
}

// ── Money Flow Index (MFI) Helper ─────────────────────────────────────────────
function computeMfi(candles, length) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (!length || length < 2) return out;

  const tp = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  const neg = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    tp[i] = (c.high + c.low + c.close) / 3;
    if (i === 0) continue;
    const mf = tp[i] * (c.volume ?? 0);
    if (tp[i] > tp[i - 1]) pos[i] = mf;
    else if (tp[i] < tp[i - 1]) neg[i] = mf;
  }

  for (let i = 0; i < n; i++) {
    if (i < length) continue;
    let posSum = 0;
    let negSum = 0;
    for (let j = i - length + 1; j <= i; j++) {
      posSum += pos[j];
      negSum += neg[j];
    }
    if (negSum === 0) {
      if (posSum === 0) {
        out[i] = null;
      } else {
        out[i] = 100;
      }
      continue;
    }
    const mr = posSum / negSum;
    out[i] = 100 - 100 / (1 + mr);
  }

  return out;
}

// ── Shared Exit Levels Helper ──────────────────────────────────────────────────
// Computes fixed ATR-based Stop Loss and Take Profit for a given bar, matching
// makeExitFn logic. SL/TP can be toggled on/off via useSL/useTP.
function computeExitLevels(type, entryPrice, atr, slMultiplier, tpMultiplier, useSL, useTP) {
  if (!atr) return { stopLoss: null, takeProfit: null };

  const enableSL = !!useSL;
  const enableTP = !!useTP;

  if (type === "long") {
    return {
      stopLoss: enableSL ? entryPrice - atr * slMultiplier : null,
      takeProfit: enableTP ? entryPrice + atr * tpMultiplier : null,
    };
  }

  return {
    stopLoss: enableSL ? entryPrice + atr * slMultiplier : null,
    takeProfit: enableTP ? entryPrice - atr * tpMultiplier : null,
  };
}

function passesDirectionConfirm(type, bar, mode, minBodyBias) {
  if (!bar || mode === "None") return true;
  if (mode === "Candle Color") {
    return type === "long" ? bar.close >= bar.open : bar.close <= bar.open;
  }
  if (mode === "Body Bias") {
    const range = Math.max(bar.high - bar.low, PRICE_EPS);
    if (type === "long") {
      const bullishBody = Math.max(bar.close - bar.open, 0);
      return bullishBody / range >= minBodyBias;
    }
    const bearishBody = Math.max(bar.open - bar.close, 0);
    return bearishBody / range >= minBodyBias;
  }
  return true;
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PrpPivotPsarV3Strategy = {
  id: "prp-pivot-psar-v3",
  name: "PRP - Pivot Reversal - PSAR v3 (Dir prev bar)",

  paramSchema: {
    leftBars: { type: "number", label: "Left Bars", default: 2, min: 1, max: 50 },
    rightBars: { type: "number", label: "Right Bars", default: 3, min: 1, max: 50 },
    ppType: { type: "select", label: "PP Type", default: "Woodie", options: ["Standard", "Fibonacci", "Woodie", "Camarilla"] },
    ppLevels: { type: "number", label: "PP Levels", default: 1, min: 1, max: 3 },
    atrPeriod: { type: "number", label: "ATR Period", default: 14, min: 1, max: 100 },
    slMultiplier: { type: "number", label: "SL ATR Mult", default: 8.8, min: 0.1, max: 20, step: 0.1 },
    tpMultiplier: { type: "number", label: "TP ATR Mult", default: 8.8, min: 0.1, max: 50, step: 0.1 },
    useSL: { type: "select", label: "Use SL ATR", default: "No", options: ["Yes", "No"] },
    useTP: { type: "select", label: "Use TP ATR", default: "Yes", options: ["Yes", "No"] },
    filterMode: { type: "select", label: "Filter Mode", default: "RVOL", options: ["None", "RVOL", "MFI"] },
    rvolLookback: { type: "number", label: "RVOL Lookback", default: 5, min: 1, max: 200 },
    rvolMin: { type: "number", label: "Min RVOL", default: 1.7, min: 1, max: 5, step: 0.1 },
    mfiLength: { type: "number", label: "MFI Length", default: 14, min: 2, max: 100 },
    mfiMin: { type: "number", label: "MFI Min", default: 50, min: 0, max: 100 },
    directionConfirmMode: { type: "select", label: "Direction Confirm", default: "None", options: ["None", "Candle Color", "Body Bias"] },
    minBodyBias: { type: "number", label: "Min Body Bias", default: 0.2, min: 0, max: 1, step: 0.05 },
    useZoneFilter: { type: "select", label: "Zone Filter", default: "Yes", options: ["Yes", "No"] },
    zonePct: { type: "number", label: "Zone Width %", default: 2.6, min: 0.1, max: 5, step: 0.1 },
    tradeDir: { type: "select", label: "Direction", default: "Both", options: ["Long", "Short", "Both"] },
    minTick: { type: "number", label: "Min Tick", default: 1, min: 0, max: 500, step: 0.1 },
  },

  generateSignals(candles, {
    leftBars, rightBars,
    ppType, ppLevels,
    atrPeriod, slMultiplier, tpMultiplier,
    useSL, useTP,
    filterMode, rvolLookback, rvolMin, mfiLength, mfiMin,
    directionConfirmMode, minBodyBias,
    useZoneFilter, zonePct,
    tradeDir,
    minTick,
  }) {
    const TICK = minTick ?? BTCUSDT_MINTICK;
    // Precompute indicator arrays
    const atrArr = calcATR(candles, atrPeriod);
    const pivotLevels = computeDailyPivotLevels(candles, ppType);

    const useRvol = filterMode === "RVOL";
    const useMfi = filterMode === "MFI";
    const rvolArr = useRvol ? computeRvol(candles, rvolLookback) : null;
    const mfiArr = useMfi ? computeMfi(candles, mfiLength) : null;

    const zoneFilterEnabled = useZoneFilter === "Yes";
    const canLong = tradeDir === "Both" || tradeDir === "Long";
    const canShort = tradeDir === "Both" || tradeDir === "Short";
    const useSLFlag = useSL === "Yes";
    const useTPFlag = useTP === "Yes";

    const bodyBiasThreshold = Math.max(0, Math.min(1, Number(minBodyBias ?? 0)));
    const passesFilter = (type, i) => {
      const rvol = rvolArr ? rvolArr[i] : null;
      const mfi = mfiArr ? mfiArr[i] : null;
      const prevMfi = i > 0 && mfiArr ? mfiArr[i - 1] : null;

      if (useRvol) {
        if (rvol == null || rvol < rvolMin) return false;
      }

      if (useMfi) {
        if (type === "long") {
          if (mfi == null || mfi < mfiMin) return false;
          if (prevMfi != null && mfi <= prevMfi) return false;
        } else {
          const shortThresh = 100 - mfiMin;
          if (mfi == null || mfi > shortThresh) return false;
          if (prevMfi != null && mfi >= prevMfi) return false;
        }
      }

      // RVOL/MFI at breakout bar i; direction confirm on previous bar (setup before break).
      if (directionConfirmMode !== "None") {
        if (i < 1) return false;
        if (!passesDirectionConfirm(type, candles[i - 1], directionConfirmMode, bodyBiasThreshold)) {
          return false;
        }
      }

      return true;
    };

    // exitFn factory: closes over indicator arrays + params + entry details
    const makeExitFn = (type, entryPrice) => (bar, barIndex) => {
      if (!bar) return null;
      const atr = atrArr[barIndex];
      if (!atr) return null;

      const { stopLoss, takeProfit } = computeExitLevels(
        type,
        entryPrice,
        atr,
        slMultiplier,
        tpMultiplier,
        useSLFlag,
        useTPFlag
      );

      if (type === "long") {
        if (stopLoss != null && bar.low <= stopLoss) {
          return {
            exitPrice: Math.min(bar.open, stopLoss),
            exitSignal: "Stop Loss",
            timestamp: bar.timestamp,
          };
        }
        if (takeProfit != null && bar.high >= takeProfit) {
          return {
            exitPrice: Math.max(bar.open, takeProfit),
            exitSignal: "Take Profit",
            timestamp: bar.timestamp,
          };
        }
      } else {
        if (stopLoss != null && bar.high >= stopLoss) {
          return {
            exitPrice: Math.max(bar.open, stopLoss),
            exitSignal: "Stop Loss",
            timestamp: bar.timestamp,
          };
        }
        if (takeProfit != null && bar.low <= takeProfit) {
          return {
            exitPrice: Math.min(bar.open, takeProfit),
            exitSignal: "Take Profit",
            timestamp: bar.timestamp,
          };
        }
      }
      return null;
    };

    const signals = [];
    let hprice = 0;    // last pivot high (entry trigger for longs)
    let lprice = 0;    // last pivot low  (entry trigger for shorts)
    let longArmed = false;
    let shortArmed = false;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      const levels = pivotLevels[i];

      // ── STEP 1: Execute pending stop orders ────────────────────────────────
      if (i > 0) {
        if (longArmed && hprice > 0 && bar.high >= hprice + TICK) {
          const stopPrice = hprice + TICK;
          const entryPrice = bar.open > stopPrice ? bar.open : stopPrice;
          if (canLong && passesFilter("long", i)) {
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "long",
              label: "LE",
              entryPrice,
              stopLevel: hprice,
              exitFn: makeExitFn("long", entryPrice),
            });
          }
          longArmed = false;
        }
        if (shortArmed && lprice > 0 && bar.low <= lprice - TICK) {
          const stopPrice = lprice - TICK;
          const entryPrice = bar.open < stopPrice ? bar.open : stopPrice;
          if (canShort && passesFilter("short", i)) {
            signals.push({
              barIndex: i,
              time: bar.time,
              timestamp: bar.timestamp,
              type: "short",
              label: "SE",
              entryPrice,
              stopLevel: lprice,
              exitFn: makeExitFn("short", entryPrice),
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

  getPendingLevels(candles, {
    leftBars, rightBars,
    ppType, ppLevels,
    useZoneFilter, zonePct,
    tradeDir,
    minTick,
    filterMode, rvolLookback, rvolMin, mfiLength, mfiMin,
  }) {
    if (!candles.length) return { buy: null, sell: null };
    const TICK = minTick ?? BTCUSDT_MINTICK;
    const pivotLevels = computeDailyPivotLevels(candles, ppType);
    const zoneFilterEnabled = useZoneFilter === "Yes";
    const canLong = tradeDir === "Both" || tradeDir === "Long";
    const canShort = tradeDir === "Both" || tradeDir === "Short";

    let hprice = 0, lprice = 0, longArmed = false, shortArmed = false;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      const levels = pivotLevels[i];

      if (i > 0) {
        if (longArmed && hprice > 0 && bar.high >= hprice + TICK) longArmed = false;
        if (shortArmed && lprice > 0 && bar.low <= lprice - TICK) shortArmed = false;
      }

      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);
      if (swh !== null) hprice = swh;
      if (swl !== null) lprice = swl;

      if (swl !== null) {
        const zoneOk = !zoneFilterEnabled || isNearSupport(lprice, levels, ppLevels, zonePct);
        // RVOL/MFI filter is applied at the actual stop trigger time in generateSignals(),
        // not at arming time, so we only arm by pivot + zoneOk here.
        if (zoneOk) longArmed = true;
        else if (longArmed && bar.high > hprice) longArmed = false;
      } else if (longArmed && bar.high > hprice) longArmed = false;

      if (swh !== null) {
        const zoneOk = !zoneFilterEnabled || isNearResistance(hprice, levels, ppLevels, zonePct);
        // RVOL/MFI filter is applied at the actual stop trigger time in generateSignals(),
        // not at arming time, so we only arm by pivot + zoneOk here.
        if (zoneOk) shortArmed = true;
        else if (shortArmed && bar.low < lprice) shortArmed = false;
      } else if (shortArmed && bar.low < lprice) shortArmed = false;
    }
    let ret = {
      buy: canLong && longArmed && hprice > 0 ? hprice + TICK : null,
      sell: canShort && shortArmed && lprice > 0 ? lprice - TICK : null,
    }
    if (ret.buy || ret.sell) {
      console.warn(`==== Pending Buy|Sell ====`, {
        buy: canLong && longArmed && hprice > 0 ? hprice + TICK : null,
        sell: canShort && shortArmed && lprice > 0 ? lprice - TICK : null,
        time: new Date().toISOString()
      })
    } else {
      // console.log('==== No Pending Buy|Sell ====')
    }

    return {
      buy: canLong && longArmed && hprice > 0 ? hprice + TICK : null,
      sell: canShort && shortArmed && lprice > 0 ? lprice - TICK : null,
    };
  },

  // Returns current effective SL/TP levels for the active open trade, to be
  // visualized as horizontal lines on the chart. Only used for PRP strategy.
  getActiveExitLevels(candles, {
    atrPeriod, slMultiplier, tpMultiplier, useSL, useTP,
  }, openTrade) {
    if (!candles.length || !openTrade) return { stopLoss: null, takeProfit: null };

    const { entryPrice, entryBarIndex } = openTrade;
    if (entryBarIndex == null || entryPrice == null) return { stopLoss: null, takeProfit: null };

    const side = openTrade.type === "Long" ? "long" : "short";
    const atrArr = calcATR(candles, atrPeriod);

    const barIndex = candles.length - 1;
    if (barIndex < 0 || barIndex >= candles.length) return { stopLoss: null, takeProfit: null };

    const bar = candles[barIndex];
    const atr = atrArr[barIndex];

    return computeExitLevels(
      side,
      entryPrice,
      atr,
      slMultiplier,
      tpMultiplier,
      useSL === "Yes",
      useTP === "Yes"
    );
  },

  // Current RVOL (latest bar) for visualization in header.
  // Only meaningful when filterMode is RVOL.
  getCurrentRvol(candles, {
    filterMode,
    rvolLookback,
  }) {
    if (!candles?.length) return null;
    if (filterMode !== "RVOL") return null;
    const lookback = Number(rvolLookback ?? 0);
    const rvolArr = computeRvol(candles, lookback);
    const last = rvolArr?.[rvolArr.length - 1];
    return typeof last === "number" && Number.isFinite(last) ? last : null;
  },

  // Current swing pivots (for chart lines) — based on PRP's pivot detector
  getCurrentPivots(candles, {
    leftBars, rightBars,
  }) {
    if (!candles.length) return { pivotHigh: null, pivotLow: null, pivotHighTime: null, pivotLowTime: null };
    let hprice = 0;
    let lprice = 0;
    let pivotHighTime = null;
    let pivotLowTime = null;
    for (let i = 0; i < candles.length; i++) {
      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);
      if (swh !== null) {
        hprice = swh;
        const pivotIdx = i - rightBars;
        pivotHighTime = pivotIdx >= 0 ? candles[pivotIdx]?.time ?? null : null;
      }
      if (swl !== null) {
        lprice = swl;
        const pivotIdx = i - rightBars;
        pivotLowTime = pivotIdx >= 0 ? candles[pivotIdx]?.time ?? null : null;
      }
    }
    return {
      pivotHigh: hprice > 0 ? hprice : null,
      pivotLow:  lprice > 0 ? lprice : null,
      pivotHighTime: typeof pivotHighTime === "number" ? pivotHighTime : null,
      pivotLowTime: typeof pivotLowTime === "number" ? pivotLowTime : null,
    };
  },
};
