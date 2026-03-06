// Pivot Reversal Strategy — translated from TradingView Pine Script v6
//
// Original Pine Script logic:
//   swh = ta.pivothigh(leftBars, rightBars)
//   hprice := swh_cond ? swh : hprice[1]
//   le := swh_cond ? true : (le[1] and high > hprice ? false : le[1])
//   if (le) strategy.entry("PivRevLE", long, stop = hprice + mintick)
//
//   swl = ta.pivotlow(leftBars, rightBars)
//   lprice := swl_cond ? swl : lprice[1]
//   se := swl_cond ? true : (se[1] and low < lprice ? false : se[1])
//   if (se) strategy.entry("PivRevSE", short, stop = lprice - mintick)
//
// Entry type: STOP ORDER (không phải market order tại close)
//   PivRevLE: mua khi giá VƯỢT LÊN TRÊN pivot high (breakout mua)
//   PivRevSE: bán khi giá XUYÊN XUỐNG DƯỚI pivot low (breakdown bán)

const BTCUSDT_MINTICK = 0.1; // Bybit BTCUSDT Perp mintick = $0.1

// ── Pivot High Detection ──────────────────────────────────────────────────────
// Tại bar i, kiểm tra bar (i - rightBars) có là pivot high không:
// high tại (i - rightBars) phải là highest trong window [i-leftBars-rightBars .. i]
function getPivotHigh(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;

  const pivotHigh = candles[pivotIdx].high;

  // Left bars: tất cả phải thấp hơn pivot high (strictly less)
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].high >= pivotHigh) return null;
  }

  // Right bars: tất cả phải thấp hơn pivot high (strictly less)
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].high >= pivotHigh) return null;
  }

  return pivotHigh;
}

// ── Pivot Low Detection ───────────────────────────────────────────────────────
function getPivotLow(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars) return null;

  const pivotLow = candles[pivotIdx].low;

  // Left bars: tất cả phải cao hơn pivot low (strictly greater)
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].low <= pivotLow) return null;
  }

  // Right bars: tất cả phải cao hơn pivot low (strictly greater)
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].low <= pivotLow) return null;
  }

  return pivotLow;
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PivotReversalStrategy = {
  id: "pivot-reversal",
  name: "Pivot Reversal Strategy",

  // Schema → UI form tự động sinh ra từ đây
  paramSchema: {
    leftBars:  { type: "number", label: "Left Bars",  default: 3, min: 1, max: 50 },
    rightBars: { type: "number", label: "Right Bars", default: 3, min: 1, max: 50 },
  },

  // Pure function: candles[] + params → signals[]
  // Mô phỏng stop order logic của TradingView:
  //   - Stop order đặt cuối bar N, execute tại bar N+1 nếu giá cross stop level
  generateSignals(candles, { leftBars, rightBars }) {
    const signals = [];
    const TICK = BTCUSDT_MINTICK;

    // State machines khớp với Pine Script variables
    let hprice = 0; // last pivot high price
    let le = false; // long entry armed (stop order active)
    let lprice = 0; // last pivot low price
    let se = false; // short entry armed (stop order active)

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // ── STEP 1: Execute pending stop orders (từ bar trước) ──────────────────
      // Mô phỏng TradingView: order đặt tại bar N → execute tại bar N+1
      if (i > 0) {
        // Long stop: bar.high >= hprice + TICK → entry triggers
        if (le && hprice > 0 && bar.high >= hprice + TICK) {
          // Fill price: nếu bar mở trên stop → fill tại open (gap up)
          // Ngược lại → fill tại stop price
          const stopPrice = hprice + TICK;
          const entryPrice = bar.open > stopPrice ? bar.open : stopPrice;
          signals.push({
            barIndex: i,
            time: bar.time,         // seconds (cho lightweight-charts marker)
            timestamp: bar.timestamp, // ms (cho display)
            type: "long",
            label: "PivRevLE",
            entryPrice,
            stopLevel: hprice,
          });
          le = false; // disarm sau khi stop trigger
        }

        // Short stop: bar.low <= lprice - TICK → entry triggers
        if (se && lprice > 0 && bar.low <= lprice - TICK) {
          const stopPrice = lprice - TICK;
          const entryPrice = bar.open < stopPrice ? bar.open : stopPrice;
          signals.push({
            barIndex: i,
            time: bar.time,
            timestamp: bar.timestamp,
            type: "short",
            label: "PivRevSE",
            entryPrice,
            stopLevel: lprice,
          });
          se = false; // disarm
        }
      }

      // ── STEP 2: Detect pivot high/low tại bar i ──────────────────────────────
      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);
      const swh_cond = swh !== null;
      const swl_cond = swl !== null;

      // ── STEP 3: Update hprice và le flag (Pine Script logic) ─────────────────
      // hprice := swh_cond ? swh : hprice[1]
      if (swh_cond) hprice = swh;

      // le := swh_cond ? true : (le[1] and high > hprice ? false : le[1])
      if (swh_cond) {
        le = true;
      } else if (le && bar.high > hprice) {
        // Giá đã vượt pivot high mà không trigger stop → disarm
        le = false;
      }

      // ── STEP 4: Update lprice và se flag ─────────────────────────────────────
      // lprice := swl_cond ? swl : lprice[1]
      if (swl_cond) lprice = swl;

      // se := swl_cond ? true : (se[1] and low < lprice ? false : se[1])
      if (swl_cond) {
        se = true;
      } else if (se && bar.low < lprice) {
        // Giá đã xuyên dưới pivot low mà không trigger stop → disarm
        se = false;
      }
    }

    return signals;
  },
};
