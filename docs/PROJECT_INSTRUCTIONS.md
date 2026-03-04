# TradingView Backtesting Clone - Project Instructions

## Project Overview

Build a web-based system that accurately replicates TradingView's Strategy Backtesting features, including candlestick chart rendering, strategy signal generation, and trade reporting.

**Tech Stack:** React (JSX artifacts) with Tailwind CSS, lightweight-charts (TradingView's official library) for charting, in-memory data store.

**Target Market:** BTCUSDT Perpetual Contract (Bybit) — 15-minute timeframe.

---

## Architecture

```
src/
├── data/           # Candle data (OHLCV) & data generation utilities
├── chart/          # Candlestick chart (lightweight-charts based)
├── strategy/       # Strategy algorithms (Pivot Reversal etc.)
├── backtest/       # Backtesting engine - runs strategy against data
├── components/     # UI components (TradeList, Metrics, Controls)
└── App.jsx         # Main layout orchestrating all modules
```

---

## Phase 1: Data Infrastructure & Candlestick Chart

### 1.1 — Candle Data Model

Each candle object follows this schema:

```ts
interface Candle {
  timestamp: number;    // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

- Generate or hardcode realistic BTCUSDT 15m candle data (minimum 500 candles).
- Price range: ~62,000 – 74,000 USDT (matching the screenshot context).
- Data must be sorted ascending by timestamp.

### 1.2 — Candlestick Chart Component

Build the chart using **lightweight-charts** (TradingView's official open-source library):

- **CDN:** `https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js`
- **Candle series:** `CandlestickSeries` — automatically renders green/red candles based on open vs close.
- **Volume series:** `HistogramSeries` on a separate price scale (`priceScaleId: 'volume'`, `scaleMargins: { top: 0.8, bottom: 0 }`), colored by candle direction.
- **Data format:** `{ time: <unix seconds>, open, high, low, close }` — note: lightweight-charts uses **seconds**, not milliseconds.
- **Y-axis:** Built-in price scale with auto-fit. Configure via `rightPriceScale` options.
- **X-axis:** Built-in time scale. Use `timeScale().fitContent()` after loading data.
- **Crosshair:** Built-in — configure via `crosshair` options (magnet mode, line colors).
- **Pan & Zoom:** Built-in — horizontal scroll and pinch/wheel zoom handled natively.
- **OHLCV header bar:** Subscribe to `chart.subscribeCrosshairMove(param)` to get hovered candle data, render O/H/L/C values in a React overlay div positioned at top-left.
- **Current price line:** Use `series.createPriceLine({ price, color, lineWidth, lineStyle: LineStyle.Dashed })`.
- **Signal markers:** Use `series.setMarkers([{ time, position, color, shape, text }])` for entry/exit arrows with labels.
- **Resize handling:** Wrap chart in a `ResizeObserver` — call `chart.resize(width, height)` on change.
- **Dark theme options:**
  ```js
  {
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#363a45' },
    timeScale: { borderColor: '#363a45', timeVisible: true, secondsVisible: false }
  }
  ```

### 1.3 — Time Controls

- Timeframe selector buttons: 1D, 5D, 1M, 3M, 6M, YTD, 1Y, 5Y, All.
- Date range display in top-right area.
- Current time display with timezone (UTC+7).

---

## Phase 2: Strategy Engine & Trade Table

### 2.1 — Pivot Reversal Strategy Algorithm

Implement the **Pivot Reversal Strategy** as shown in the screenshot:

#### Core Logic:

```
// Pivot High Detection (for Short Entry signals)
pivotHigh(leftBars, rightBars):
  - A bar's HIGH is a pivot high if it is the highest high
    among (leftBars) bars to the left AND (rightBars) bars to the right.

// Pivot Low Detection (for Long Entry signals)  
pivotLow(leftBars, rightBars):
  - A bar's LOW is a pivot low if it is the lowest low
    among (leftBars) bars to the left AND (rightBars) bars to the right.

// Default parameters: leftBars = 4, rightBars = 2
```

#### Signal Generation:

| Signal | Condition | Action |
|--------|-----------|--------|
| **PivRevLE** (Pivot Reversal Long Entry) | Pivot Low detected | Enter Long / Exit Short |
| **PivRevSE** (Pivot Reversal Short Entry) | Pivot High detected | Enter Short / Exit Long |

#### Entry/Exit Rules:

- When a **PivRevLE** signal fires:
  - If currently Short → Exit Short at this bar's close, then Enter Long.
  - If no position → Enter Long.
- When a **PivRevSE** signal fires:
  - If currently Long → Exit Long at this bar's close, then Enter Short.
  - If no position → Enter Short.
- Position size: 1 contract (use close price as position value in USDT).
- Signals are evaluated at bar close (end of 15m candle).
- The strategy is **always in market** after the first signal (reversal strategy).

#### Chart Overlays for Signals (lightweight-charts markers):

Use `candlestickSeries.setMarkers(markers)` with the following marker config:

- **Long Entry (PivRevLE):**
  ```js
  { time, position: 'belowBar', color: '#2962ff', shape: 'arrowUp', text: 'PivRevLE' }
  ```
- **Short Entry (PivRevSE):**
  ```js
  { time, position: 'aboveBar', color: '#f23645', shape: 'arrowDown', text: 'PivRevSE' }
  ```
- Markers array must be sorted by `time` ascending.
- The "-2" / "+2" offset labels visible in TradingView reference the `rightBars` parameter — include in marker text if desired (e.g., `text: 'PivRevLE\n+2'`).

### 2.2 — Backtesting Engine

The engine iterates through candles and:

1. Detects pivot points (requires leftBars + rightBars lookback/lookahead).
2. Generates signals (PivRevLE / PivRevSE) at the confirmation bar.
3. Executes trades based on signal rules.
4. Tracks position state: `{ type: 'long'|'short'|'none', entryPrice, entryTime }`.
5. Records each trade with full metadata.

#### Trade Record Schema:

```ts
interface Trade {
  tradeNumber: number;
  type: 'Long' | 'Short';
  entryTime: number;       // Unix ms
  entryPrice: number;
  entrySignal: string;     // 'PivRevLE' | 'PivRevSE'
  exitTime: number | null;
  exitPrice: number | null;
  exitSignal: string | null;
  positionSize: number;    // Always 1
  positionValue: number;   // In USDT (entry price * size)
  netPnL: number;          // In USDT
  netPnLPercent: number;   // As decimal (0.03 = 3%)
  favorableExcursion: number;      // Max profit during trade (USDT)
  favorableExcursionPercent: number;
  adverseExcursion: number;        // Max loss during trade (USDT)
  adverseExcursionPercent: number;
  cumulativePnL: number;           // Running total P&L
  cumulativePnLPercent: number;
}
```

#### P&L Calculation Rules:

- **Long trade P&L:** `(exitPrice - entryPrice) * positionSize`
- **Short trade P&L:** `(entryPrice - exitPrice) * positionSize`
- **Favorable Excursion (MFE):** Max unrealized profit during the trade's lifetime.
  - Long: `max(high - entryPrice)` across all bars while in trade.
  - Short: `max(entryPrice - low)` across all bars while in trade.
- **Adverse Excursion (MAE):** Max unrealized loss during the trade's lifetime.
  - Long: `max(entryPrice - low)` across all bars while in trade (shown as negative).
  - Short: `max(high - entryPrice)` across all bars while in trade (shown as negative).
- **Cumulative P&L:** Running sum of all closed trades' Net P&L.

### 2.3 — Strategy Report Panel

Build the bottom panel UI matching TradingView's "Strategy Report":

#### Header:
- Strategy name: "Pivot Reversal Strategy" with dropdown icon.
- Date range: "Jan 1, 2026 — Mar 4, 2026" with calendar icon.
- Download button.

#### Tabs:
- **Metrics** tab (future implementation).
- **List of Trades** tab (primary focus).

#### List of Trades Table:

**Columns (exact match to TradingView):**

| Column | Description | Alignment |
|--------|-------------|-----------|
| Trade # | Trade number + "Long"/"Short" badge | Left |
| Type | "Entry" or "Exit" | Left |
| Date and time | "Mar 04, 2026, 13:30" format | Left |
| Signal | "PivRevLE", "PivRevSE", or "Open" | Left |
| Price | Entry/exit price with "USDT" suffix | Right |
| Position size | Quantity + value in K USDT | Center |
| Net P&L | USDT amount + percentage (green/red) | Right |
| Favorable excursion | USDT amount + percentage | Right |
| Adverse excursion | USDT amount + percentage (negative) | Right |
| Cumulative P&L | USDT amount + percentage | Right |

**Table Behavior:**

- Each trade occupies **2 rows**: Exit row on top, Entry row below.
- Trade # and badge span both rows (vertically centered).
- Position size, Net P&L, Favorable/Adverse excursion, Cumulative P&L span both rows.
- **Sticky header:** Column headers stick to top on scroll.
- **Row grouping:** Alternating background for trade groups.
- Trades sorted descending by trade number (newest first).
- Color coding: Positive P&L in green (`#22ab94`), negative in red (`#f23645`).
- "Long" badge: blue text, "Short" badge: red text.
- Open/active trade: Exit signal shows "Open", exit price is current price.

---

## Design System (TradingView Dark Theme)

```css
--bg-primary: #131722;
--bg-secondary: #1e222d;
--bg-tertiary: #2a2e39;
--text-primary: #d1d4dc;
--text-secondary: #787b86;
--border: #363a45;
--green: #22ab94;
--red: #f23645;
--blue: #2962ff;
--font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
--font-mono: 'Source Code Pro', monospace;
```

---

## Key Constraints

1. **Accuracy first:** Signal generation must match TradingView's Pivot Reversal Strategy output exactly.
2. **Performance:** lightweight-charts handles canvas rendering natively — chart must remain smooth with 500+ candles.
3. **Pixel-perfect table:** The List of Trades table must visually match the TradingView screenshot — same column layout, same row grouping, same color coding.
4. **Single-file artifacts:** Each deliverable should be a self-contained `.jsx` file unless complexity requires splitting.
5. **No external API calls for data:** Use generated/hardcoded candle data within the artifact.
6. **All monetary values in USDT** with appropriate decimal precision (1 decimal for prices, 2 for percentages).

---

## Deliverable Sequence

### Phase 1 Deliverables:
1. **Candle data generator** — Function that produces realistic BTCUSDT 15m candles.
2. **Candlestick chart component** — Full interactive chart with dark theme.
3. **Integration** — Chart rendering generated candle data with all overlays.

### Phase 2 Deliverables:
1. **Pivot Reversal Strategy algorithm** — Signal detection module.
2. **Backtesting engine** — Trade execution and P&L calculation.
3. **Signal overlays on chart** — Entry/exit arrows with labels.
4. **List of Trades table** — Sticky-header table matching TradingView exactly.
5. **Strategy Report panel** — Complete bottom panel with tabs and header.

---

## Reference

The attached screenshot (`Screenshot_2026-03-04_at_14_19_20.png`) is the primary visual reference. All UI elements should match this screenshot's layout, colors, typography, and data presentation as closely as possible.
