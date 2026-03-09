// EMA 200 Trendline Break Strategy — translated from TradingView Pine Script v6
//
// Pine core:
//   ema200    = ta.ema(close, emaLength)
//   recentHigh = ta.highest(high, lookback)
//   recentLow  = ta.lowest(low, lookback)
//   downTrend = ta.highest(high[1], lookback)
//   upTrend   = ta.lowest(low[1], lookback)
//   buyCondition  = close > ema200 and close > downTrend and close[1] <= downTrend
//   sellCondition = close < ema200 and close < upTrend   and close[1] >= upTrend
//   longSL  = ta.lowest(low, 3)
//   shortSL = ta.highest(high, 3)
//   longTP  = close + (close - longSL) * rr
//   shortTP = close - (shortSL - close) * rr
//
// App adaptation:
//   - Entries: market at next bar open when condition fires.
//   - Exits: fixed stopLoss / takeProfit, no trailing.

const BTCUSDT_MINTICK = 0.1;

// ── EMA Helper (SMA seed then EMA) ─────────────────────────────────────────────
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

// ── Rolling highest / lowest helpers ──────────────────────────────────────────
function rollingHighest(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  for (let i = 0; i < n; i++) {
    if (i < length - 1) continue;
    let h = -Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      const v = values[j];
      if (v > h) h = v;
    }
    res[i] = h;
  }
  return res;
}

function rollingLowest(values, length) {
  const n = values.length;
  const res = new Array(n).fill(null);
  if (length <= 0) return res;
  for (let i = 0; i < n; i++) {
    if (i < length - 1) continue;
    let l = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      const v = values[j];
      if (v < l) l = v;
    }
    res[i] = l;
  }
  return res;
}

export const Ema200TrendlineBreakoutStrategy = {
  id: "ema200-trendline-breakout",
  name: "EMA 200 Trendline Break Strategy",

  paramSchema: {
    emaLength: { type: "number", label: "EMA Length", default: 200, min: 1, max: 500 },
    lookback:  { type: "number", label: "Trendline Lookback", default: 8, min: 2, max: 50 },
    rr:        { type: "number", label: "Risk Reward", default: 2.0, min: 0.1, max: 10, step: 0.1 },
  },

  generateSignals(candles, { emaLength, lookback, rr }) {
    const n = candles.length;
    if (n < Math.max(emaLength, lookback, 3) + 2) return [];

    const closes = candles.map((c) => c.close);
    const highs  = candles.map((c) => c.high);
    const lows   = candles.map((c) => c.low);

    const emaArr = calcEMA(closes, emaLength);

    // downTrend: highest high[1] over lookback → use highs from [i-lookback .. i-1]
    const downTrend = new Array(n).fill(null);
    const upTrend   = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i === 0) continue;
      const start = Math.max(0, i - lookback);
      const end   = i - 1;
      if (end < start) continue;
      let h = -Infinity;
      let l = Infinity;
      for (let j = start; j <= end; j++) {
        if (highs[j] > h) h = highs[j];
        if (lows[j]  < l) l = lows[j];
      }
      downTrend[i] = h;
      upTrend[i]   = l;
    }

    // 3-bar SL arrays
    const longSLArr  = rollingLowest(lows, 3);
    const shortSLArr = rollingHighest(highs, 3);

    const signals = [];
    const windowStart = Math.max(emaLength, lookback, 3);

    for (let i = windowStart; i < n - 1; i++) {
      const bar     = candles[i];
      const prevBar = candles[i - 1];
      const ema     = emaArr[i];
      const dt      = downTrend[i];
      const ut      = upTrend[i];
      const longSL  = longSLArr[i];
      const shortSL = shortSLArr[i];

      if (
        ema == null || dt == null || ut == null ||
        longSL == null || shortSL == null
      ) continue;

      const buyCondition =
        bar.close > ema &&
        bar.close > dt &&
        prevBar.close <= dt;

      const sellCondition =
        bar.close < ema &&
        bar.close < ut &&
        prevBar.close >= ut;

      if (!buyCondition && !sellCondition) continue;

      const entryIndex = i + 1;
      const entryBar   = candles[entryIndex];
      const entryPrice = entryBar.open;

      if (buyCondition) {
        const risk = bar.close - longSL;
        if (risk <= BTCUSDT_MINTICK) continue;
        const tp = bar.close + risk * rr;
        signals.push({
          barIndex:  entryIndex,
          time:      entryBar.time,
          timestamp: entryBar.timestamp,
          type:      "long",
          label:     "EMA 200 BUY",
          entryPrice,
          stopLoss:  longSL,
          takeProfit: tp,
        });
      }

      if (sellCondition) {
        const risk = shortSL - bar.close;
        if (risk <= BTCUSDT_MINTICK) continue;
        const tp = bar.close - risk * rr;
        signals.push({
          barIndex:  entryIndex,
          time:      entryBar.time,
          timestamp: entryBar.timestamp,
          type:      "short",
          label:     "EMA 200 SELL",
          entryPrice,
          stopLoss:  shortSL,
          takeProfit: tp,
        });
      }
    }

    return signals;
  },

  getPendingLevels() {
    return { buy: null, sell: null };
  },
};

