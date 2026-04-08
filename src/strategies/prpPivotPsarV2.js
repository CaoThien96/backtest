// PRP v2 - Pivot Reversal + PSAR (close-confirm breakout + retest-limit entry)

import { PrpPivotPsarStrategy } from "./prpPivotPsar";

const BTCUSDT_MINTICK = 0.1;
const PRICE_EPS = 1e-9;

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

function computeDailyPivotLevels(candles, ppType) {
  const days = new Map();
  for (let i = 0; i < candles.length; i++) {
    const key = Math.floor(candles[i].timestamp / 86400000);
    if (!days.has(key)) {
      days.set(key, { high: candles[i].high, low: candles[i].low, close: candles[i].close, firstIdx: i });
    } else {
      const d = days.get(key);
      d.high = Math.max(d.high, candles[i].high);
      d.low = Math.min(d.low, candles[i].low);
      d.close = candles[i].close;
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
          s1: pp - 0.382 * range, s2: pp - 0.618 * range, s3: pp - range,
        };
        break;
      }
      case "Woodie": {
        const pp = (H + L + 2 * C) / 4;
        levels = {
          pp, r1: 2 * pp - L, r2: pp + range, r3: H + 2 * (pp - L),
          s1: 2 * pp - H, s2: pp - range, s3: L - 2 * (H - pp),
        };
        break;
      }
      case "Camarilla": {
        const pp = (H + L + C) / 3;
        levels = {
          pp,
          r1: C + range * 1.1 / 12, r2: C + range * 1.1 / 6, r3: C + range * 1.1 / 4,
          s1: C - range * 1.1 / 12, s2: C - range * 1.1 / 6, s3: C - range * 1.1 / 4,
        };
        break;
      }
      default: {
        const pp = (H + L + C) / 3;
        levels = {
          pp, r1: 2 * pp - L, r2: pp + range, r3: pp + 2 * range,
          s1: 2 * pp - H, s2: pp - range, s3: pp - 2 * range,
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

function getPivotHigh(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;
  const pivotHigh = candles[pivotIdx].high;
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].high >= pivotHigh) return null;
  }
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].high > pivotHigh) return null;
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
    if (candles[j].low < pivotLow) return null;
  }
  return pivotLow;
}

function isNearSupport(price, levels, ppLevels, zonePct) {
  if (!levels) return true;
  const w = price * zonePct / 100;
  const pts = [levels.pp, levels.s1];
  if (ppLevels >= 2) pts.push(levels.s2);
  if (ppLevels >= 3) pts.push(levels.s3);
  return pts.some((p) => Math.abs(price - p) <= w);
}

function isNearResistance(price, levels, ppLevels, zonePct) {
  if (!levels) return true;
  const w = price * zonePct / 100;
  const pts = [levels.pp, levels.r1];
  if (ppLevels >= 2) pts.push(levels.r2);
  if (ppLevels >= 3) pts.push(levels.r3);
  return pts.some((p) => Math.abs(price - p) <= w);
}

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
    sum += v;
    sum -= candles[i - lookback].volume ?? 0;
    const avg = sum / lookback;
    out[i] = avg > 0 ? v / avg : null;
  }
  return out;
}

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
      out[i] = posSum === 0 ? null : 100;
      continue;
    }
    const mr = posSum / negSum;
    out[i] = 100 - 100 / (1 + mr);
  }

  return out;
}

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

export const PrpPivotPsarV2Strategy = {
  ...PrpPivotPsarStrategy,
  id: "prp-pivot-psar-v2",
  name: "PRP - Pivot Reversal - PSAR v2 (Close + Retest)",
  paramSchema: {
    ...PrpPivotPsarStrategy.paramSchema,
    limitOffsetPct: {
      type: "number",
      label: "Limit Offset %",
      default: 0,
      min: 0,
      max: 10,
      step: 0.1,
    },
    pendingExpiryMode: {
      type: "select",
      label: "Pending Expiry",
      default: "Opposite Breakout",
      options: ["Opposite Breakout", "1 Bar", "3 Bars", "5 Bars"],
    },
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
    limitOffsetPct,
    pendingExpiryMode,
  }) {
    const TICK = minTick ?? BTCUSDT_MINTICK;
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
      const bar = candles[i];
      const rvol = rvolArr ? rvolArr[i] : null;
      const mfi = mfiArr ? mfiArr[i] : null;
      const prevMfi = i > 0 && mfiArr ? mfiArr[i - 1] : null;

      if (useRvol && (rvol == null || rvol < rvolMin)) return false;
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
      return passesDirectionConfirm(type, bar, directionConfirmMode, bodyBiasThreshold);
    };

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
          return { exitPrice: Math.min(bar.open, stopLoss), exitSignal: "Stop Loss", timestamp: bar.timestamp };
        }
        if (takeProfit != null && bar.high >= takeProfit) {
          return { exitPrice: Math.max(bar.open, takeProfit), exitSignal: "Take Profit", timestamp: bar.timestamp };
        }
      } else {
        if (stopLoss != null && bar.high >= stopLoss) {
          return { exitPrice: Math.max(bar.open, stopLoss), exitSignal: "Stop Loss", timestamp: bar.timestamp };
        }
        if (takeProfit != null && bar.low <= takeProfit) {
          return { exitPrice: Math.min(bar.open, takeProfit), exitSignal: "Take Profit", timestamp: bar.timestamp };
        }
      }
      return null;
    };

    const signals = [];
    let hprice = 0;
    let lprice = 0;
    let longArmed = false;
    let shortArmed = false;
    let pendingLong = null;  // { limitPrice, stopLevel, confirmIndex }
    let pendingShort = null; // { limitPrice, stopLevel, confirmIndex }

    const offsetPct = Math.max(0, Number(limitOffsetPct ?? 0));
    const pendingTtlBars =
      pendingExpiryMode === "1 Bar" ? 1 :
      pendingExpiryMode === "3 Bars" ? 3 :
      pendingExpiryMode === "5 Bars" ? 5 :
      null;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      const levels = pivotLevels[i];

      // Stage B: fill pending limit from earlier bars (never same bar as confirmation).
      if (pendingLong && pendingTtlBars != null && i > pendingLong.confirmIndex + pendingTtlBars) {
        pendingLong = null;
      }
      if (pendingShort && pendingTtlBars != null && i > pendingShort.confirmIndex + pendingTtlBars) {
        pendingShort = null;
      }

      if (pendingLong && i > pendingLong.confirmIndex && bar.low <= pendingLong.limitPrice) {
        const entryPrice = pendingLong.limitPrice;
        signals.push({
          barIndex: i,
          time: bar.time,
          timestamp: bar.timestamp,
          type: "long",
          label: "LE",
          entryPrice,
          stopLevel: pendingLong.stopLevel,
          exitFn: makeExitFn("long", entryPrice),
        });
        pendingLong = null;
      } else if (pendingShort && i > pendingShort.confirmIndex && bar.high >= pendingShort.limitPrice) {
        const entryPrice = pendingShort.limitPrice;
        signals.push({
          barIndex: i,
          time: bar.time,
          timestamp: bar.timestamp,
          type: "short",
          label: "SE",
          entryPrice,
          stopLevel: pendingShort.stopLevel,
          exitFn: makeExitFn("short", entryPrice),
        });
        pendingShort = null;
      }

      // Stage A: breakout must be confirmed by close.
      if (i > 0) {
        const longBreakoutConfirmed = longArmed && hprice > 0 && bar.close >= hprice + TICK;
        const shortBreakoutConfirmed = shortArmed && lprice > 0 && bar.close <= lprice - TICK;

        // Default mode: keep pending order until opposite breakout invalidates it.
        if (pendingExpiryMode === "Opposite Breakout") {
          if (pendingLong && shortBreakoutConfirmed) pendingLong = null;
          if (pendingShort && longBreakoutConfirmed) pendingShort = null;
        }

        if (longBreakoutConfirmed) {
          if (canLong && passesFilter("long", i)) {
            const baseLevel = hprice + TICK;
            const limitPrice = baseLevel * (1 - offsetPct / 100);
            pendingLong = {
              limitPrice,
              stopLevel: hprice,
              confirmIndex: i,
            };
          }
          longArmed = false;
        }

        if (shortBreakoutConfirmed) {
          if (canShort && passesFilter("short", i)) {
            const baseLevel = lprice - TICK;
            const limitPrice = baseLevel * (1 + offsetPct / 100);
            pendingShort = {
              limitPrice,
              stopLevel: lprice,
              confirmIndex: i,
            };
          }
          shortArmed = false;
        }
      }

      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);
      if (swh !== null) hprice = swh;
      if (swl !== null) lprice = swl;

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
