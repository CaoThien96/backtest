// Centered RSI Cross Strategy — translated from TradingView Pine Script v5
//
// Pine core:
//   rsi = ta.rsi(close, rsiLength)
//   crsi = (rsi - 50) * 2
//   longCondition  = ta.crossover(crsi, -50)
//   shortCondition = ta.crossunder(crsi, 50)
//   slPoints = atr(atrLength) * atrMult
//   strategy.entry(...); strategy.exit(..., profit=tpPoints, loss=slPoints, [trail_*])
//
// In this app:
//   - Entries: market at next bar open (runBacktest convention)
//   - Sizing: uses global Position Size (USDT), not contracts
//   - Exits: simplified — no SL/TP/trailing; positions close only on opposite signal

const BTCUSDT_MINTICK = 0.1;

// ── RSI Helper (Wilder's RMA) ──────────────────────────────────────────────────
function calcRSI(candles, length) {
  const rsi = new Array(candles.length).fill(null);
  if (candles.length < length) return rsi;
  const u = [];
  const d = [];
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    const change = candles[i].close - prevClose;
    u.push(change > 0 ? change : 0);
    d.push(change < 0 ? -change : 0);
  }
  let avgU = u.slice(0, length).reduce((s, v) => s + v, 0) / length;
  let avgD = d.slice(0, length).reduce((s, v) => s + v, 0) / length;
  rsi[length - 1] = avgD === 0 ? 100 : 100 - 100 / (1 + avgU / avgD);
  for (let i = length; i < candles.length; i++) {
    avgU = (avgU * (length - 1) + u[i]) / length;
    avgD = (avgD * (length - 1) + d[i]) / length;
    rsi[i] = avgD === 0 ? 100 : 100 - 100 / (1 + avgU / avgD);
  }
  return rsi;
}

// ── ATR Helper (Wilder's RMA) ──────────────────────────────────────────────────
function calcATR(candles, length) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
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

// ── ExitFn factory (ATR SL + TP + optional trailing) ───────────────────────────
function makeExitFn(candles, atrArr, {
  type,
  entryIndex,
  entryPrice,
  slPoints,
  tpPoints,
  useTrail,
  trailStart,
  trailDistance,
}) {
  return (bar, barIndex) => {
    if (barIndex <= entryIndex) return null;

    const atr = atrArr[entryIndex];
    if (!atr || !slPoints || !tpPoints) return null;

    // Base fixed SL/TP in price terms
    const tpLongPrice  = entryPrice + tpPoints;
    const tpShortPrice = entryPrice - tpPoints;

    // Highest/lowest since entry for trailing logic
    let highestHigh = -Infinity;
    let lowestLow   = Infinity;
    for (let i = entryIndex; i <= barIndex; i++) {
      const c = candles[i];
      if (c.high > highestHigh) highestHigh = c.high;
      if (c.low  < lowestLow)   lowestLow = c.low;
    }

    if (type === "long") {
      const fixedSL = entryPrice - slPoints;
      let effectiveSL = fixedSL;

      if (useTrail && highestHigh > -Infinity) {
        const trailArmed = highestHigh >= entryPrice + trailStart;
        if (trailArmed) {
          const trailSL = highestHigh - trailDistance;
          effectiveSL = Math.max(fixedSL, trailSL);
        }
      }

      if (bar.low <= effectiveSL) {
        const exitPrice = Math.min(bar.open, effectiveSL);
        return {
          exitPrice,
          exitSignal: "Stop Loss",
          timestamp: bar.timestamp,
        };
      }

      if (bar.high >= tpLongPrice) {
        const exitPrice = Math.max(bar.open, tpLongPrice);
        return {
          exitPrice,
          exitSignal: "Take Profit",
          timestamp: bar.timestamp,
        };
      }
    } else {
      const fixedSL = entryPrice + slPoints;
      let effectiveSL = fixedSL;

      if (useTrail && lowestLow < Infinity) {
        const trailArmed = lowestLow <= entryPrice - trailStart;
        if (trailArmed) {
          const trailSL = lowestLow + trailDistance;
          effectiveSL = Math.min(fixedSL, trailSL);
        }
      }

      if (bar.high >= effectiveSL) {
        const exitPrice = Math.max(bar.open, effectiveSL);
        return {
          exitPrice,
          exitSignal: "Stop Loss",
          timestamp: bar.timestamp,
        };
      }

      if (bar.low <= tpShortPrice) {
        const exitPrice = Math.min(bar.open, tpShortPrice);
        return {
          exitPrice,
          exitSignal: "Take Profit",
          timestamp: bar.timestamp,
        };
      }
    }

    return null;
  };
}

// ── Strategy Object ─────────────────────────────────────────────────────────────
export const CenteredRsiCrossStrategy = {
  id: "centered-rsi-cross",
  name: "Centered RSI Cross Strategy",

  paramSchema: {
    rsiLength: { type: "number", label: "RSI Length", default: 14, min: 2, max: 100 },
  },

  generateSignals(candles, { rsiLength }) {
    const rsiArr  = calcRSI(candles, rsiLength);
    const crsiArr = rsiArr.map((v) => (v === null ? null : (v - 50) * 2));

    const signals = [];
    if (candles.length < rsiLength + 2) return signals;

    for (let i = 1; i < candles.length - 1; i++) {
      const prev = crsiArr[i - 1];
      const curr = crsiArr[i];
      if (prev === null || curr === null) continue;

      const longCond  = prev <= -50 && curr > -50;
      const shortCond = prev >= 50 && curr < 50;
      if (!longCond && !shortCond) continue;

      const type = longCond ? "long" : "short";
      const nextBarIndex = i + 1;
      const nextBar = candles[nextBarIndex];
      const entryPrice = nextBar.open;

      signals.push({
        barIndex: nextBarIndex,
        time: nextBar.time,
        timestamp: nextBar.timestamp,
        type,
        label: type === "long" ? "CRSI Long" : "CRSI Short",
        entryPrice,
      });
    }

    return signals;
  },

  getPendingLevels() {
    // Market entries only — no pending stop orders to visualize
    return { buy: null, sell: null };
  },
};

