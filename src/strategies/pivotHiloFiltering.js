// Pivot Hilo Stop Strategy — translated from Pivot Hilo Stop Order Strategy (Pine v4)
//
// Core idea:
//   - Detect pivot highs/lows over (left, right) windows.
//   - Use those pivots as stop levels for pending breakout orders.
//   - Optional MA filter: only arm stops when fast MA vs slow MA confirms trend.
//   - Cancel pending stops when MA trend reverses (avoid trap).

const BTCUSDT_MINTICK = 1;
const PRICE_EPS = 1e-9;

// ── Moving Average Variants ────────────────────────────────────────────────────
function calcSMA(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null) continue;
    sum += v;
    if (i >= length) {
      sum -= values[i - length] ?? 0;
    }
    if (i >= length - 1) {
      res[i] = sum / length;
    }
  }
  return res;
}

function calcEMA(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (n === 0 || length <= 0) return res;
  const alpha = 2 / (length + 1);
  let sum = 0;
  let ema = null;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null) continue;
    if (ema === null) {
      sum += v;
      if (i === length - 1) {
        ema = sum / length;
        res[i] = ema;
      }
    } else {
      ema = ema * (1 - alpha) + v * alpha;
      res[i] = ema;
    }
  }
  return res;
}

function calcWMA(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  const denom = (length * (length + 1)) / 2;
  for (let i = length - 1; i < n; i++) {
    let num = 0;
    let w = 1;
    for (let j = i - length + 1; j <= i; j++) {
      const v = values[j];
      if (v == null) { num = null; break; }
      num += v * w;
      w++;
    }
    res[i] = num == null ? null : num / denom;
  }
  return res;
}

function calcHMA(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  const halfLen = Math.max(1, Math.round(length / 2));
  const sqrtLen = Math.max(1, Math.round(Math.sqrt(length)));
  const wmaHalf = calcWMA(values, halfLen);
  const wmaFull = calcWMA(values, length);
  const diff = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (wmaHalf[i] == null || wmaFull[i] == null) continue;
    diff[i] = 2 * wmaHalf[i] - wmaFull[i];
  }
  return calcWMA(diff, sqrtLen);
}

function calcZLEMA(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  const lag = (length - 1) / 2;
  const lagInt = Math.round(lag);
  const zInput = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const src = values[i];
    const lagSrc = i - lagInt >= 0 ? values[i - lagInt] : values[0];
    zInput[i] = src + (src - lagSrc);
  }
  return calcEMA(zInput, length);
}

function variantMa(type, values, length) {
  switch (type) {
    case "EMA":
      return calcEMA(values, length);
    case "WMA":
      return calcWMA(values, length);
    case "Hull MA":
      return calcHMA(values, length);
    case "ZeroLag EMA":
      return calcZLEMA(values, length);
    case "SMA":
    default:
      return calcSMA(values, length);
  }
}

// ── Pivot Detection with left/right ────────────────────────────────────────────
function getPivotHighFromSeries(highs, i, left, right) {
  const pivotIdx = i - right;
  if (pivotIdx < left || pivotIdx + right >= highs.length) return null;
  const ph = highs[pivotIdx];
  // left side: no higher high
  for (let j = pivotIdx - left; j < pivotIdx; j++) {
    if (highs[j] > ph) return null;
  }
  // right side: strictly lower highs
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (highs[j] >= ph) return null;
  }
  return ph;
}

function getPivotLowFromSeries(lows, i, left, right) {
  const pivotIdx = i - right;
  if (pivotIdx < left || pivotIdx + right >= lows.length) return null;
  const pl = lows[pivotIdx];
  // left side: no lower low
  for (let j = pivotIdx - left; j < pivotIdx; j++) {
    if (lows[j] < pl) return null;
  }
  // right side: strictly higher lows
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (lows[j] <= pl) return null;
  }
  return pl;
}

export const PivotHiloFilteringStrategy = {
  id: "pivot-hilo-filtering",
  name: "Pivot Hilo Stop Strategy",

  paramSchema: {
    left:        { type: "number", label: "Pivot Left",          default: 5,  min: 1, max: 50 },
    right:       { type: "number", label: "Pivot Right",         default: 5,  min: 1, max: 50 },
    useRenko:    { type: "boolean", label: "Use Renko (Open/Close as Hi/Lo)", default: true },
    useMaFilter: { type: "boolean", label: "Use MA Filter & Cancel", default: true },
    fastMaType:  { type: "select", label: "Fast MA Type", default: "EMA", options: ["SMA", "EMA", "WMA", "Hull MA", "ZeroLag EMA"] },
    fastMaLen:   { type: "number", label: "Fast MA Length",      default: 21, min: 1, max: 300 },
    slowMaType:  { type: "select", label: "Slow MA Type", default: "EMA", options: ["SMA", "EMA", "WMA", "Hull MA", "ZeroLag EMA"] },
    slowMaLen:   { type: "number", label: "Slow MA Length",      default: 55, min: 1, max: 300 },
  },

  generateSignals(candles, {
    left,
    right,
    useRenko,
    useMaFilter,
    fastMaType,
    fastMaLen,
    slowMaType,
    slowMaLen,
  }) {
    const n = candles.length;
    if (n === 0) return [];

    const highs = candles.map((c) => c.high);
    const lows  = candles.map((c) => c.low);
    const opens = candles.map((c) => c.open);
    const closes = candles.map((c) => c.close);

    const highSeries = useRenko
      ? candles.map((c) => Math.max(c.open, c.close))
      : highs;
    const lowSeries = useRenko
      ? candles.map((c) => Math.min(c.open, c.close))
      : lows;

    let fastMa = null;
    let slowMa = null;
    let canLongArr = null;
    let canShortArr = null;

    if (useMaFilter) {
      fastMa = variantMa(fastMaType, closes, fastMaLen);
      slowMa = variantMa(slowMaType, closes, slowMaLen);
      canLongArr  = new Array(n).fill(false);
      canShortArr = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        const f = fastMa[i];
        const s = slowMa[i];
        const c = closes[i];
        if (f != null && s != null && c != null) {
          canLongArr[i]  = f > s && c > f;
          canShortArr[i] = f < s && c < f;
        }
      }
    }

    const signals = [];
    let pvHigh = null;
    let pvLow  = null;
    let upperStop = null;
    let lowerStop = null;

    for (let i = 0; i < n; i++) {
      const barHigh = highSeries[i];
      const barLow  = lowSeries[i];
      const open    = opens[i];

      const canLong  = !useMaFilter || (canLongArr && canLongArr[i]);
      const canShort = !useMaFilter || (canShortArr && canShortArr[i]);

      // ── Execute pending stops first (like other stop strategies) ───────────
      if (i > 0) {
        if (upperStop != null && barHigh >= upperStop - PRICE_EPS) {
          const entryPrice = open > upperStop ? open : upperStop;
          signals.push({
            barIndex:  i,
            time:      candles[i].time,
            timestamp: candles[i].timestamp,
            type:      "long",
            label:     "PvtLE",
            entryPrice,
            stopLevel: upperStop - BTCUSDT_MINTICK,
          });
          upperStop = null;
        }

        if (lowerStop != null && barLow <= lowerStop + PRICE_EPS) {
          const entryPrice = open < lowerStop ? open : lowerStop;
          signals.push({
            barIndex:  i,
            time:      candles[i].time,
            timestamp: candles[i].timestamp,
            type:      "short",
            label:     "PvtSE",
            entryPrice,
            stopLevel: lowerStop + BTCUSDT_MINTICK,
          });
          lowerStop = null;
        }
      }

      // ── Cancel-on-MA-reverse: disarm stops if filter no longer valid ───────
      if (useMaFilter) {
        if (!canLong)  upperStop = null;
        if (!canShort) lowerStop = null;
      }

      // ── Detect new pivots at bar i (confirmation bar) ──────────────────────
      const ph = getPivotHighFromSeries(highSeries, i, left, right);
      if (ph != null) pvHigh = ph;

      const pl = getPivotLowFromSeries(lowSeries, i, left, right);
      if (pl != null) pvLow = pl;

      // ── (Re)arm stops when we have valid pivot and trend filter allows ─────
      if (pvHigh != null && canLong) {
        upperStop = pvHigh + BTCUSDT_MINTICK;
      }

      if (pvLow != null && canShort) {
        lowerStop = pvLow - BTCUSDT_MINTICK;
      }
    }

    return signals;
  },

  getPendingLevels(candles, params) {
    const n = candles.length;
    if (n === 0) return { buy: null, sell: null };

    const {
      left,
      right,
      useRenko,
      useMaFilter,
      fastMaType,
      fastMaLen,
      slowMaType,
      slowMaLen,
    } = params;

    const highs = candles.map((c) => c.high);
    const lows  = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    const highSeries = useRenko
      ? candles.map((c) => Math.max(c.open, c.close))
      : highs;
    const lowSeries = useRenko
      ? candles.map((c) => Math.min(c.open, c.close))
      : lows;

    let fastMa = null;
    let slowMa = null;
    let canLongArr = null;
    let canShortArr = null;

    if (useMaFilter) {
      fastMa = variantMa(fastMaType, closes, fastMaLen);
      slowMa = variantMa(slowMaType, closes, slowMaLen);
      canLongArr  = new Array(n).fill(false);
      canShortArr = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        const f = fastMa[i];
        const s = slowMa[i];
        const c = closes[i];
        if (f != null && s != null && c != null) {
          canLongArr[i]  = f > s && c > f;
          canShortArr[i] = f < s && c < f;
        }
      }
    }

    let pvHigh = null;
    let pvLow  = null;
    let upperStop = null;
    let lowerStop = null;

    for (let i = 0; i < n; i++) {
      const canLong  = !useMaFilter || (canLongArr && canLongArr[i]);
      const canShort = !useMaFilter || (canShortArr && canShortArr[i]);

      if (useMaFilter) {
        if (!canLong)  upperStop = null;
        if (!canShort) lowerStop = null;
      }

      const ph = getPivotHighFromSeries(highSeries, i, left, right);
      if (ph != null) pvHigh = ph;
      const pl = getPivotLowFromSeries(lowSeries, i, left, right);
      if (pl != null) pvLow = pl;

      if (pvHigh != null && canLong) {
        upperStop = pvHigh + BTCUSDT_MINTICK;
      }

      if (pvLow != null && canShort) {
        lowerStop = pvLow - BTCUSDT_MINTICK;
      }
    }

    return {
      buy: upperStop,
      sell: lowerStop,
    };
  },
};

