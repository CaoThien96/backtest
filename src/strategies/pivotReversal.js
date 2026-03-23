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

const BTCUSDT_MINTICK = 1; // Bybit BTCUSDT Perp mintick = $0.1
const PRICE_EPS = 1e-9; // float-safe: bar.high >= stopLevel can fail when stopLevel = 67449.3+0.1

// Debug: set window.__PIVOT_DEBUG_TS__ = 1741389300 (0h15 8 Mar 2026 UTC) then refetch/change interval to log that bar

// ── Pivot High Detection (TradingView logic) ────────────────────────────────────
// Tại bar i, kiểm tra bar (i - rightBars) có là pivot high không.
// Bên phải: thấp hơn chặt (không bằng) để chuẩn TradingView.
function getPivotHigh(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars || pivotIdx + rightBars >= candles.length) return null;

  const ph = candles[pivotIdx].high;

  // Bên trái: Không được có nến nào CAO HƠN ph
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].high > ph) return null;
  }

  // Bên phải: Tất cả nến phải THẤP HƠN ph (Không được bằng)
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].high >= ph) return null;
  }

  return ph;
}

// ── Pivot Low Detection (TradingView logic) ─────────────────────────────────────
// Tại bar i, kiểm tra bar (i - rightBars) có là pivot low không.
// Bên phải: cao hơn chặt (không bằng) để chuẩn TradingView.
function getPivotLow(candles, i, leftBars, rightBars) {
  const pivotIdx = i - rightBars;
  if (pivotIdx < leftBars || pivotIdx + rightBars >= candles.length) return null;

  const pl = candles[pivotIdx].low;

  // Bên trái: Không được có nến nào THẤP HƠN pl
  for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
    if (candles[j].low < pl) return null;
  }

  // Bên phải: Tất cả nến phải CAO HƠN pl (Không được bằng)
  for (let j = pivotIdx + 1; j <= i; j++) {
    if (candles[j].low <= pl) return null;
  }

  return pl;
}

// ── Strategy Object ───────────────────────────────────────────────────────────
export const PivotReversalStrategy = {
  id: "pivot-reversal",
  name: "Pivot Reversal Strategy",

  // Schema → UI form tự động sinh ra từ đây
  paramSchema: {
    leftBars:  { type: "number", label: "Left Bars",  default: 3, min: 1, max: 50 },
    rightBars: { type: "number", label: "Right Bars", default: 3, min: 1, max: 50 },
    minTick:   { type: "number", label: "Min Tick",   default: 1, min: 0, max: 500, step: 0.1 },
  },

  // Pure function: candles[] + params → signals[]
  // Mô phỏng stop order logic của TradingView:
  //   - Stop order đặt cuối bar N, execute tại bar N+1 nếu giá cross stop level
  generateSignals(candles, { leftBars, rightBars, minTick }) {
    const signals = [];
    const TICK = minTick ?? BTCUSDT_MINTICK;

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
        // Long stop: bar.high >= hprice + TICK → entry triggers (float-safe)
        const longStop = hprice + TICK;
        if (le && hprice > 0 && bar.high >= longStop - PRICE_EPS) {
          // Fill price: nếu bar mở trên stop → fill tại open (gap up)
          // Ngược lại → fill tại stop price
          const stopPrice = longStop;
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

        // Short stop: bar.low <= lprice - TICK → entry triggers (float-safe)
        const shortStop = lprice - TICK;
        if (se && lprice > 0 && bar.low <= shortStop + PRICE_EPS) {
          const stopPrice = shortStop;
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

  getPendingLevels(candles, { leftBars, rightBars, minTick }) {
    if (!candles.length) return { buy: null, sell: null };
    const TICK = minTick ?? BTCUSDT_MINTICK;
    let hprice = 0, le = false, lprice = 0, se = false;

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      if (i > 0) {
        const longStop = hprice + TICK;
        if (le && hprice > 0 && bar.high >= longStop - PRICE_EPS) le = false;
        const shortStop = lprice - TICK;
        if (se && lprice > 0 && bar.low <= shortStop + PRICE_EPS) se = false;
      }
      const swh = getPivotHigh(candles, i, leftBars, rightBars);
      const swl = getPivotLow(candles, i, leftBars, rightBars);
      if (swh !== null) hprice = swh;
      if (swh !== null) le = true;
      else if (le && bar.high > hprice) le = false;
      if (swl !== null) lprice = swl;
      if (swl !== null) se = true;
      else if (se && bar.low < lprice) se = false;
    }

    return {
      buy:  le && hprice > 0 ? hprice + TICK : null,
      sell: se && lprice > 0 ? lprice - TICK : null,
    };
  },

  // Current swing pivots and their source candle time (for chart lines/markers)
  getCurrentPivots(candles, { leftBars, rightBars }) {
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
      pivotLow: lprice > 0 ? lprice : null,
      pivotHighTime: typeof pivotHighTime === "number" ? pivotHighTime : null,
      pivotLowTime: typeof pivotLowTime === "number" ? pivotLowTime : null,
    };
  },
};
