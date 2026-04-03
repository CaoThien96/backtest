/**
 * Dynamic RVOL for each minute row inside a forming timeframe bar.
 * Matches `computeRvol()` semantics in `src/strategies/prpPivotPsar.js`:
 * - denominator avg window includes the current forming-bar volume
 * - window = (lookback-1 previous TF bars) + (current forming cumulative volume)
 */
export function calcDynamicRvolForMinuteRows(minuteCandles, timeframeCandles, entryStartMs, lookback) {
  if (!lookback || lookback <= 0 || !minuteCandles.length || !timeframeCandles.length) {
    return new Array(minuteCandles.length).fill(null);
  }

  const prevTfBars = timeframeCandles
    .filter((c) => c?.timestamp < entryStartMs)
    .sort((a, b) => a.time - b.time);
  if (prevTfBars.length < lookback) return new Array(minuteCandles.length).fill(null);

  const prevCount = Math.max(0, lookback - 1);
  const prevSumVol = prevCount
    ? prevTfBars.slice(-prevCount).reduce((s, c) => s + (c?.volume ?? 0), 0)
    : 0;

  const out = new Array(minuteCandles.length).fill(null);
  let cumVol = 0;
  for (let i = 0; i < minuteCandles.length; i++) {
    cumVol += minuteCandles[i]?.volume ?? 0;
    const avg = (prevSumVol + cumVol) / lookback;
    out[i] = avg > 0 ? cumVol / avg : null;
  }
  return out;
}
