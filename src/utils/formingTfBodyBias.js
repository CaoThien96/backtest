/**
 * Cumulative "forming" OHLC for the timeframe bar from minute candles
 * between startIdx and currIdx (inclusive).
 */
export function buildFormingTfCandle(minuteCandles, startIdx, currIdx) {
  const first = minuteCandles?.[startIdx];
  if (!first) return null;
  let high = first.high;
  let low = first.low;
  for (let i = startIdx; i <= currIdx; i++) {
    const c = minuteCandles[i];
    if (!c) continue;
    if (typeof c.high === "number" && Number.isFinite(c.high)) high = Math.max(high, c.high);
    if (typeof c.low === "number" && Number.isFinite(c.low)) low = Math.min(low, c.low);
  }
  const close = minuteCandles?.[currIdx]?.close;
  return {
    open: first.open,
    high,
    low,
    close,
  };
}

/** Body bias for long (bullish body / range) or short (bearish body / range), same as PRP direction confirm. */
export function getBodyBias(side, formingCandle) {
  if (!formingCandle) return 0;
  const open = formingCandle.open;
  const close = formingCandle.close;
  const high = formingCandle.high;
  const low = formingCandle.low;
  if (![open, close, high, low].every((v) => typeof v === "number" && Number.isFinite(v))) return 0;
  const range = Math.max(high - low, 1e-9);
  if (side === "long") {
    const bullishBody = Math.max(close - open, 0);
    return bullishBody / range;
  }
  const bearishBody = Math.max(open - close, 0);
  return bearishBody / range;
}
