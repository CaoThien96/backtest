// Momentum ZigZag Strategy — "Momentum-based ZigZag" by Peter_O
// Translated from Pine Script @version=4
//
// Momentum indicator (MACD / MA / QQE) determines trend direction.
// ZigZag tracks pivot levels at each direction change.
// RSI(5) force detection filters "forced" momentum flips.
// Entry: market order on next bar open; Exit: Stop Loss or Take Profit.

// ── EMA Helper ────────────────────────────────────────────────────────────────
// EMA with SMA seed; null values in input are skipped transparently.
function calcEMAArr(values, length) {
  const result = new Array(values.length).fill(null);
  const alpha = 2 / (length + 1);
  let sum = 0, seedCount = 0, prevEMA = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    if (prevEMA === null) {
      sum += values[i]; seedCount++;
      if (seedCount === length) { result[i] = sum / length; prevEMA = result[i]; }
    } else {
      result[i] = prevEMA * (1 - alpha) + values[i] * alpha;
      prevEMA = result[i];
    }
  }
  return result;
}

// ── SMA Helper ────────────────────────────────────────────────────────────────
function calcSMA(values, length) {
  const result = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    const slice = values.slice(i - length + 1, i + 1).filter(v => v !== null);
    if (slice.length === length) result[i] = slice.reduce((s, v) => s + v, 0) / length;
  }
  return result;
}

// ── RSI Helper (Wilder's RMA) ─────────────────────────────────────────────────
// Same implementation as pivotReversalRsi.js
function calcRSI(candles, length) {
  const rsi = new Array(candles.length).fill(null);
  if (candles.length < length) return rsi;
  const u = [], d = [];
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

// ── MACD Momentum ─────────────────────────────────────────────────────────────
// up = crossover(macd, signal); down = crossunder(macd, signal)
function computeMACD(candles, fastLen, slowLen, signalLen) {
  const closes = candles.map(c => c.close);
  const fastEMA = calcEMAArr(closes, fastLen);
  const slowEMA = calcEMAArr(closes, slowLen);
  const macd = fastEMA.map((v, i) =>
    v !== null && slowEMA[i] !== null ? v - slowEMA[i] : null
  );
  const signal = calcEMAArr(macd, signalLen);
  const up   = new Array(candles.length).fill(false);
  const down = new Array(candles.length).fill(false);
  for (let i = 1; i < candles.length; i++) {
    if (macd[i] !== null && signal[i] !== null && macd[i-1] !== null && signal[i-1] !== null) {
      up[i]   = macd[i-1] <= signal[i-1] && macd[i] > signal[i];
      down[i] = macd[i-1] >= signal[i-1] && macd[i] < signal[i];
    }
  }
  return { up, down };
}

// ── MA Momentum (SMA) ─────────────────────────────────────────────────────────
// up   = valley at i-1: ma[i-2] > ma[i-1] AND ma[i] > ma[i-1]
// down = peak  at i-1: ma[i-2] < ma[i-1] AND ma[i] < ma[i-1]
function computeMA(candles, length) {
  const closes = candles.map(c => c.close);
  const ma = calcSMA(closes, length);
  const up   = new Array(candles.length).fill(false);
  const down = new Array(candles.length).fill(false);
  for (let i = 2; i < candles.length; i++) {
    if (ma[i] !== null && ma[i-1] !== null && ma[i-2] !== null) {
      up[i]   = ma[i-2] > ma[i-1] && ma[i] > ma[i-1]; // valley
      down[i] = ma[i-2] < ma[i-1] && ma[i] < ma[i-1]; // peak
    }
  }
  return { up, down };
}

// ── QQE Momentum ──────────────────────────────────────────────────────────────
// Translated from Pine Script QQE indicator.
// trend flips -1→1 = up signal; 1→-1 = down signal.
function computeQQE(candles, rsiPeriod, qqeFactor, smoothingFactor) {
  const rsiArr  = calcRSI(candles, rsiPeriod);
  const rsiMa   = calcEMAArr(rsiArr, smoothingFactor);
  const wildersP = rsiPeriod * 2 - 1;

  // AtrRsi = |RsiMa[i] - RsiMa[i-1]|
  const atrRsi = rsiMa.map((v, i) =>
    (v !== null && i > 0 && rsiMa[i-1] !== null) ? Math.abs(v - rsiMa[i-1]) : null
  );
  const maAtrRsi = calcEMAArr(atrRsi, wildersP);
  const dar      = calcEMAArr(maAtrRsi, wildersP).map(v => v !== null ? v * qqeFactor : null);

  const up   = new Array(candles.length).fill(false);
  const down = new Array(candles.length).fill(false);

  let longband = 0, shortband = 0, trend = 0;
  let lastQQEhigh = candles[0]?.high ?? 0;
  let lastQQElow  = candles[0]?.low  ?? 0;
  let lastQQExLongBar = -Infinity, lastQQExShortBar = -Infinity;

  for (let i = 1; i < candles.length; i++) {
    const rs = rsiMa[i];
    if (rs === null || dar[i] === null) continue;

    const newlongband  = rs - dar[i];
    const newshortband = rs + dar[i];

    const prevRS = rsiMa[i - 1] ?? rs;
    longband  = (prevRS > longband  && rs > longband)  ? Math.max(longband,  newlongband)  : newlongband;
    shortband = (prevRS < shortband && rs < shortband) ? Math.min(shortband, newshortband) : newshortband;

    const prevTrend    = trend;
    const qqeGoingUp   = lastQQExLongBar  > lastQQExShortBar;
    const qqeGoingDown = lastQQExShortBar > lastQQExLongBar;

    if ((candles[i].high > lastQQEhigh && qqeGoingUp)   || (qqeGoingDown && qqeGoingUp))   lastQQEhigh = candles[i].high;
    if ((candles[i].low  < lastQQElow  && qqeGoingDown) || (qqeGoingUp  && qqeGoingDown))  lastQQElow  = candles[i].low;

    const crossOverShort = (rsiMa[i-1] <= shortband && rs > shortband) || candles[i].high > lastQQEhigh;
    const crossUnderLong = (rsiMa[i-1] >= longband  && rs < longband)  || candles[i].low  < lastQQElow;
    trend = crossOverShort ? 1 : crossUnderLong ? -1 : trend;

    if (trend === 1 && prevTrend !== 1) {
      up[i] = true;
      lastQQExLongBar = i;
      lastQQEhigh = candles[i].high;
    }
    if (trend === -1 && prevTrend !== -1) {
      down[i] = true;
      lastQQExShortBar = i;
      lastQQElow = candles[i].low;
    }
  }
  return { up, down };
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const MomentumZigzagStrategy = {
  id: "momentum-zigzag",
  name: "Momentum ZigZag Strategy",

  paramSchema: {
    momentum:        { type: "select", label: "Momentum",      default: "QQE",   options: ["MACD", "MA", "QQE"] },
    // MACD
    macdFast:        { type: "number", label: "MACD Fast",     default: 12,      min: 1,   max: 200 },
    macdSlow:        { type: "number", label: "MACD Slow",     default: 26,      min: 1,   max: 200 },
    macdSignal:      { type: "number", label: "MACD Signal",   default: 9,       min: 1,   max: 50  },
    // MA
    maLength:        { type: "number", label: "MA Length",     default: 20,      min: 1,   max: 200 },
    // QQE
    qqeRsiPeriod:    { type: "number", label: "RSI Period",    default: 14,      min: 1,   max: 50  },
    qqeFactor:       { type: "number", label: "QQE Factor",    default: 4.238,   min: 0.1, max: 20,  step: 0.001 },
    qqeSmoothing:    { type: "number", label: "RSI Smoothing", default: 5,       min: 1,   max: 50  },
    // Exit
    takeProfitLevel: { type: "number", label: "Take Profit $", default: 200,     min: 1,   max: 10000 },
  },

  generateSignals(candles, {
    momentum, macdFast, macdSlow, macdSignal,
    maLength, qqeRsiPeriod, qqeFactor, qqeSmoothing,
    takeProfitLevel,
  }) {
    // ── Compute momentum UP/DOWN flip arrays ──────────────────────────────────
    let momUp, momDown;
    if (momentum === "MACD") {
      ({ up: momUp, down: momDown } = computeMACD(candles, macdFast, macdSlow, macdSignal));
    } else if (momentum === "MA") {
      ({ up: momUp, down: momDown } = computeMA(candles, maLength));
    } else { // QQE (default)
      ({ up: momUp, down: momDown } = computeQQE(candles, qqeRsiPeriod, qqeFactor, qqeSmoothing));
    }

    const rsi5Arr = calcRSI(candles, 5);

    const signals = [];
    let direction = 0; // 1 = up, -1 = down, 0 = unknown

    // ZigZag state
    let zz_peak   = 0;
    let zz_bottom = 0;

    // valuewhen(momentumUP, ZigZag, 0) → stop loss reference for longs
    // valuewhen(momentumDOWN, ZigZag, 0) → stop loss reference for shorts
    let pl = null; // last zigzag value at momentumUP
    let ph = null; // last zigzag value at momentumDOWN

    // Force detection trackers (updated AFTER checks → matches Pine's [1])
    let lastMomentumUpIdx   = -Infinity;
    let lastMomentumDownIdx = -Infinity;
    let lastRsi5OBIdx       = -Infinity; // last bar with RSI5 > 80
    let lastRsi5OSIdx       = -Infinity; // last bar with RSI5 < 20

    for (let i = 0; i < candles.length; i++) {
      const bar        = candles[i];
      const momentumUp   = momUp[i];
      const momentumDown = momDown[i];

      // ── Direction state machine ─────────────────────────────────────────────
      const prevDirection = direction;
      if (momentumUp)   direction = 1;
      if (momentumDown) direction = -1;

      const goingUp  = direction === 1;
      const goingDown = direction === -1;
      const wasUp    = prevDirection === 1;
      const wasDown  = prevDirection === -1;

      // ── ZigZag ─────────────────────────────────────────────────────────────
      // Fires at direction change: turning UP → emits prev_bottom; turning DOWN → emits prev_peak
      const turningUp   = goingUp  && wasDown;
      const turningDown = goingDown && wasUp;
      const zigzagValue = turningUp ? zz_bottom : turningDown ? zz_peak : null;

      // Update peak/bottom tracking
      const new_zz_peak   = (bar.high > zz_peak   && goingUp)  || turningUp   ? bar.high : zz_peak;
      const new_zz_bottom = (bar.low  < zz_bottom && goingDown) || turningDown ? bar.low  : zz_bottom;
      zz_peak   = new_zz_peak;
      zz_bottom = new_zz_bottom;

      // valuewhen: capture zigzag at momentum flip bars
      if (momentumUp   && zigzagValue !== null) pl = zigzagValue;
      if (momentumDown && zigzagValue !== null) ph = zigzagValue;

      // ── Force detection (Pine's [1] behavior: read before updating) ─────────
      const downWasForceUp = momentumDown && lastRsi5OBIdx >= lastMomentumUpIdx;
      const upWasForceDown = momentumUp   && lastRsi5OSIdx >= lastMomentumDownIdx;

      // ── Entry signals ───────────────────────────────────────────────────────
      const goLong  = momentumUp   && !upWasForceDown  && i + 1 < candles.length;
      const goShort = momentumDown && !downWasForceUp   && i + 1 < candles.length;

      if (goLong) {
        const nextBar    = candles[i + 1];
        const stopLoss   = pl !== null ? Math.min(bar.low, pl) : bar.low;
        const takeProfit = nextBar.open + takeProfitLevel;
        signals.push({
          barIndex:   i + 1,
          time:       nextBar.time,
          timestamp:  nextBar.timestamp,
          type:       "long",
          label:      "MBZ Long",
          entryPrice: nextBar.open,
          stopLevel:  stopLoss,
          stopLoss,
          takeProfit,
        });
      }

      if (goShort) {
        const nextBar    = candles[i + 1];
        const stopLoss   = ph !== null ? Math.max(bar.high, ph) : bar.high;
        const takeProfit = nextBar.open - takeProfitLevel;
        signals.push({
          barIndex:   i + 1,
          time:       nextBar.time,
          timestamp:  nextBar.timestamp,
          type:       "short",
          label:      "MBZ Short",
          entryPrice: nextBar.open,
          stopLevel:  stopLoss,
          stopLoss,
          takeProfit,
        });
      }

      // ── Update trackers AFTER all checks ────────────────────────────────────
      if (momentumUp)   lastMomentumUpIdx   = i;
      if (momentumDown) lastMomentumDownIdx = i;
      const r5 = rsi5Arr[i];
      if (r5 !== null && r5 > 80) lastRsi5OBIdx = i;
      if (r5 !== null && r5 < 20) lastRsi5OSIdx = i;
    }

    return signals;
  },
};
