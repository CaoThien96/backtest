// Backtest Engine — Generic (strategy-agnostic)
//
// Nhận: candles[] + signals[] từ bất kỳ strategy nào
// Trả về: trades[] với đầy đủ P&L, MFE, MAE, cumulative P&L
//
// Trade schema khớp với TradingView's "List of Trades" table

// ── P&L Helpers ───────────────────────────────────────────────────────────────

function calcNetPnL(type, entryPrice, exitPrice) {
  return type === "long"
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
}

// MFE = Max Favorable Excursion (max unrealized profit trong suốt trade)
// MAE = Max Adverse Excursion (max unrealized loss, lưu dưới dạng số âm)
function calcExcursions(candles, entryBarIndex, exitBarIndex, entryPrice, type) {
  let mfe = 0;
  let maeMagnitude = 0;

  for (let i = entryBarIndex; i <= exitBarIndex; i++) {
    const bar = candles[i];
    if (type === "long") {
      mfe = Math.max(mfe, bar.high - entryPrice);
      maeMagnitude = Math.max(maeMagnitude, entryPrice - bar.low);
    } else {
      mfe = Math.max(mfe, entryPrice - bar.low);
      maeMagnitude = Math.max(maeMagnitude, bar.high - entryPrice);
    }
  }

  return { mfe, mae: -maeMagnitude }; // MAE là số âm
}

// ── Trade Builder ─────────────────────────────────────────────────────────────

function buildTrade({
  tradeNumber,
  type,
  entryBarIndex,
  entryPrice,
  entrySignal,
  entryTimestamp,
  exitBarIndex,
  exitPrice,
  exitSignal,
  exitTimestamp,
  candles,
  cumulativePnL,
  isOpen = false,
}) {
  const positionSize = 1;
  const positionValue = entryPrice * positionSize;

  const netPnL = calcNetPnL(type, entryPrice, exitPrice);
  const netPnLPercent = (netPnL / positionValue) * 100;

  const { mfe, mae } = calcExcursions(
    candles,
    entryBarIndex,
    exitBarIndex,
    entryPrice,
    type
  );

  const cumPnL = cumulativePnL + netPnL;

  return {
    tradeNumber,
    type: type === "long" ? "Long" : "Short",
    entryTimestamp,   // ms — để display
    entryPrice,
    entrySignal,
    exitTimestamp: isOpen ? null : exitTimestamp,
    exitPrice: isOpen ? null : exitPrice,
    exitSignal: isOpen ? null : exitSignal,
    isOpen,
    positionSize,
    positionValue,
    netPnL,
    netPnLPercent,
    favorableExcursion: mfe,
    favorableExcursionPercent: (mfe / positionValue) * 100,
    adverseExcursion: mae,
    adverseExcursionPercent: (mae / positionValue) * 100,
    cumulativePnL: cumPnL,
    // cumulativePnLPercent dùng positionValue của trade đầu tiên làm base (tính sau)
  };
}

// ── SL/TP Checker ─────────────────────────────────────────────────────────────
// Scans bars [entryBarIndex+1, upToBarIndex) for stop loss or take profit hits.
// Returns first hit { barIndex, exitPrice, exitSignal, timestamp } or null.
// Gap protection: SL fills at min/max(bar.open, stopLoss) to handle overnight gaps.
function checkSLTP(candles, position, upToBarIndex) {
  const { type, entryBarIndex, stopLoss, takeProfit, exitFn } = position;
  if (!stopLoss && !takeProfit && !exitFn) return null;
  for (let i = entryBarIndex + 1; i < upToBarIndex; i++) {
    const bar = candles[i];
    // Dynamic exit (e.g. PSAR trailing stop) — takes priority over fixed SL/TP
    if (exitFn) {
      const hit = exitFn(bar, i);
      if (hit) return { ...hit, barIndex: i };
    }
    // Fixed SL/TP fallback
    if (type === "long") {
      if (stopLoss   && bar.low  <= stopLoss)   return { barIndex: i, exitPrice: Math.min(bar.open, stopLoss),   exitSignal: "Stop Loss",   timestamp: bar.timestamp };
      if (takeProfit && bar.high >= takeProfit) return { barIndex: i, exitPrice: Math.max(bar.open, takeProfit), exitSignal: "Take Profit", timestamp: bar.timestamp };
    } else {
      if (stopLoss   && bar.high >= stopLoss)   return { barIndex: i, exitPrice: Math.max(bar.open, stopLoss),   exitSignal: "Stop Loss",   timestamp: bar.timestamp };
      if (takeProfit && bar.low  <= takeProfit) return { barIndex: i, exitPrice: Math.min(bar.open, takeProfit), exitSignal: "Take Profit", timestamp: bar.timestamp };
    }
  }
  return null;
}

// ── Main Engine ───────────────────────────────────────────────────────────────

export function runBacktest(candles, signals) {
  if (!candles.length || !signals.length) return [];

  const trades = [];
  let position = null; // { type, entryBarIndex, entryPrice, entrySignal, entryTimestamp, stopLoss?, takeProfit? }
  let tradeNumber = 0;
  let cumulativePnL = 0;

  for (const signal of signals) {
    const bar = candles[signal.barIndex];

    // Kiểm tra SL/TP trước khi xử lý signal tiếp theo
    if (position) {
      const hit = checkSLTP(candles, position, signal.barIndex);
      if (hit) {
        const trade = buildTrade({
          tradeNumber: ++tradeNumber,
          type: position.type,
          entryBarIndex: position.entryBarIndex,
          entryPrice: position.entryPrice,
          entrySignal: position.entrySignal,
          entryTimestamp: position.entryTimestamp,
          exitBarIndex: hit.barIndex,
          exitPrice: hit.exitPrice,
          exitSignal: hit.exitSignal,
          exitTimestamp: hit.timestamp,
          candles,
          cumulativePnL,
        });
        cumulativePnL = trade.cumulativePnL;
        trades.push(trade);
        position = null;
      }
    }

    // Nếu đang giữ position ngược chiều → đóng trước (reversal)
    if (position && position.type !== signal.type) {
      const exitBar = bar;
      const exitPrice = signal.entryPrice; // exit cùng price với entry mới

      const trade = buildTrade({
        tradeNumber: ++tradeNumber,
        type: position.type,
        entryBarIndex: position.entryBarIndex,
        entryPrice: position.entryPrice,
        entrySignal: position.entrySignal,
        entryTimestamp: position.entryTimestamp,
        exitBarIndex: signal.barIndex,
        exitPrice,
        exitSignal: signal.label,
        exitTimestamp: exitBar.timestamp,
        candles,
        cumulativePnL,
      });

      cumulativePnL = trade.cumulativePnL;
      trades.push(trade);
      position = null;
    }

    // Mở position mới (nếu không có position, hoặc vừa đóng)
    // Nếu cùng chiều với position hiện tại → ignore (no pyramiding)
    if (!position) {
      position = {
        type: signal.type,
        entryBarIndex: signal.barIndex,
        entryPrice: signal.entryPrice,
        entrySignal: signal.label,
        entryTimestamp: bar.timestamp, // ms
        stopLoss:   signal.stopLoss   ?? null,
        takeProfit: signal.takeProfit ?? null,
        exitFn:     signal.exitFn     ?? null,
      };
    }
  }

  // Xử lý open trade cuối cùng (chưa đóng)
  if (position) {
    // Kiểm tra SL/TP trong các bar còn lại
    const hit = checkSLTP(candles, position, candles.length);
    if (hit) {
      const trade = buildTrade({
        tradeNumber: ++tradeNumber,
        type: position.type,
        entryBarIndex: position.entryBarIndex,
        entryPrice: position.entryPrice,
        entrySignal: position.entrySignal,
        entryTimestamp: position.entryTimestamp,
        exitBarIndex: hit.barIndex,
        exitPrice: hit.exitPrice,
        exitSignal: hit.exitSignal,
        exitTimestamp: hit.timestamp,
        candles,
        cumulativePnL,
      });
      trades.push(trade);
    } else {
      const lastBar = candles[candles.length - 1];
      const exitPrice = lastBar.close; // unrealized exit tại giá close cuối

      const trade = buildTrade({
        tradeNumber: ++tradeNumber,
        type: position.type,
        entryBarIndex: position.entryBarIndex,
        entryPrice: position.entryPrice,
        entrySignal: position.entrySignal,
        entryTimestamp: position.entryTimestamp,
        exitBarIndex: candles.length - 1,
        exitPrice,
        exitSignal: null,
        exitTimestamp: null,
        candles,
        cumulativePnL,
        isOpen: true,
      });

      trades.push(trade);
    }
  }

  // Tính cumulativePnLPercent dùng positionValue của trade đầu tiên làm initial capital
  const initialCapital = trades.length > 0 ? trades[0].positionValue : 1;
  trades.forEach((t) => {
    t.cumulativePnLPercent = (t.cumulativePnL / initialCapital) * 100;
  });

  return trades;
}
