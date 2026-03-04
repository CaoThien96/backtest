# CLAUDE.md — TradingView Backtesting Clone

## What is this project?

A web-based clone of TradingView's Strategy Backtesting system. It renders interactive candlestick charts, runs trading strategy algorithms against historical candle data, and displays backtest results in a trade table — all matching TradingView's dark-themed UI pixel-for-pixel.

Target instrument: **BTCUSDT Perpetual Contract (Bybit) — 15-minute timeframe**.

## Tech Stack

- **React** (functional components + hooks) — delivered as single-file `.jsx` artifacts
- **Tailwind CSS** — core utility classes only (no compiler, no custom config)
- **lightweight-charts** (TradingView's official charting library) — candlestick rendering, time axis, price scale, crosshair, zoom/pan built-in
- **No backend** — all data is generated/hardcoded in-memory
- **No localStorage/sessionStorage** — use React state only

## Project Structure

```
├── CLAUDE.md                  # This file
├── PROJECT_INSTRUCTIONS.md    # Full spec & requirements
├── data/
│   └── candles.js             # Candle data generator + sample dataset
├── chart/
│   └── CandlestickChart.jsx   # Main chart component (lightweight-charts based)
├── strategy/
│   └── pivotReversal.js       # Pivot Reversal Strategy algorithm
├── backtest/
│   └── engine.js              # Backtesting engine (runs strategy → trades)
├── components/
│   ├── TradeTable.jsx          # List of Trades table
│   ├── StrategyReport.jsx      # Bottom panel (tabs, header, metrics)
│   └── SignalOverlay.jsx       # Arrow/label overlays on chart
└── App.jsx                     # Root layout
```

> **Note:** In practice, deliverables are single-file `.jsx` artifacts. The structure above is logical grouping for reference.

## Key Data Schemas

### Candle

```js
{ timestamp, open, high, low, close, volume }
// timestamp: Unix ms | prices: number (USDT) | volume: number (BTC)
```

### Trade

```js
{
  tradeNumber, type,           // 'Long' | 'Short'
  entryTime, entryPrice, entrySignal,
  exitTime, exitPrice, exitSignal,
  positionSize,                // always 1
  positionValue,               // USDT
  netPnL, netPnLPercent,
  favorableExcursion, favorableExcursionPercent,
  adverseExcursion, adverseExcursionPercent,
  cumulativePnL, cumulativePnLPercent
}
```

## Strategy: Pivot Reversal

- **Pivot High** (leftBars=4, rightBars=2): highest high in window → **PivRevSE** (Short Entry)
- **Pivot Low** (leftBars=4, rightBars=2): lowest low in window → **PivRevLE** (Long Entry)
- Always-in-market after first signal (reversal strategy, no flat periods)
- Signals evaluated at bar close
- Entry of new direction simultaneously exits previous direction

## Design Tokens (TradingView Dark Theme)

```
Background:    #131722 (primary), #1e222d (secondary), #2a2e39 (tertiary)
Text:          #d1d4dc (primary), #787b86 (secondary)
Border:        #363a45
Green (profit): #22ab94
Red (loss):     #f23645
Blue (long):    #2962ff
Font:          -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif
Mono:          'Source Code Pro', monospace
```

## Coding Conventions

### General
- Vietnamese comments are OK when clarifying business logic; English for code structure
- All monetary values in **USDT**, display with 1 decimal (prices) or 2 decimals (percentages)
- Timestamps in **Unix milliseconds**; display format: `"Mar 04, 2026, 13:30"`
- Always sort candles ascending by timestamp before processing
- Trades sorted **descending** by tradeNumber in the UI (newest first)

### React / JSX
- Functional components with hooks only — no class components
- Default exports for all components
- All state lives in React `useState` / `useReducer` — never browser storage
- Inline styles or Tailwind only — no separate CSS files
- Single-file artifacts: HTML/CSS/JS all in one `.jsx` file

### Chart (lightweight-charts)
- Import from `lightweight-charts` (CDN: `https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js`)
- Create chart via `createChart(container, options)` — the library handles canvas, scaling, crosshair, zoom/pan natively
- Use `CandlestickSeries` for OHLC data and `HistogramSeries` for volume
- Data format: `{ time: unixTimestamp (seconds), open, high, low, close }` — note: **seconds**, not milliseconds
- Volume series: separate `HistogramSeries` added to same chart, placed on a secondary price scale (`priceScaleId: 'volume'`)
- Signal markers: use `series.setMarkers([...])` for entry/exit arrows — built-in support for `arrowUp`, `arrowDown` shapes
- Apply TradingView dark theme via chart `layout`, `grid`, `crosshair`, `timeScale` options
- Chart auto-resizes via `ResizeObserver` on container — call `chart.applyOptions({ width, height })` or `chart.resize(w, h)`
- Time scale: use `timeScale().fitContent()` to auto-fit visible range after data load
- Price line for current price: use `series.createPriceLine({ price, color, lineWidth, lineStyle })`

### Table (List of Trades)
- Each trade = 2 rows (Exit on top, Entry below)
- Trade #, Position size, Net P&L, MFE, MAE, Cumulative P&L span both rows via `rowSpan={2}`
- Sticky `<thead>` with `position: sticky; top: 0`
- Color: positive values → `#22ab94`, negative → `#f23645`
- "Long" badge → blue text, "Short" badge → red text
- Open/active trade shows "Open" as exit signal, current price as exit price

## P&L Calculation Rules

```
Long P&L  = (exitPrice - entryPrice) * positionSize
Short P&L = (entryPrice - exitPrice) * positionSize
MFE Long  = max(candle.high - entryPrice) over trade duration
MFE Short = max(entryPrice - candle.low) over trade duration
MAE Long  = -(max(entryPrice - candle.low)) over trade duration
MAE Short = -(max(candle.high - entryPrice)) over trade duration
Cumulative P&L = running sum of all closed trades' Net P&L
Percentages = value / positionValue * 100
```

## Common Pitfalls to Avoid

1. **Pivot detection offset**: Pivot is confirmed `rightBars` candles AFTER the actual pivot candle. Signal fires on the confirmation bar, not the pivot bar itself.
2. **Off-by-one in lookback**: Need at least `leftBars + rightBars + 1` candles before first possible signal.
3. **Always-in-market**: After the first signal, the strategy never goes flat. Every PivRevLE exits any short AND enters long simultaneously (same bar, same price).
4. **MFE/MAE includes entry bar**: Start tracking from the entry candle itself.
5. **Open trade handling**: The last trade may not have an exit yet — show exit as "Open" with current (last) candle's close price. Its P&L is unrealized.
6. **Candle data range**: Prices should stay within ~62,000–74,000 USDT to match the reference screenshot context (Feb 23 – Mar 4, 2026).

## Build & Run

No build step — artifacts render directly in Claude's artifact viewer. For local development:

```bash
# If extracted to a Vite/CRA project:
npm install react react-dom lightweight-charts tailwindcss lucide-react
npm run dev
```

## Reference

- Primary visual reference: `Screenshot_2026-03-04_at_14_19_20.png`
- Full specification: `PROJECT_INSTRUCTIONS.md`
- TradingView Pine Script docs for Pivot Reversal: https://www.tradingview.com/pine-script-reference/
