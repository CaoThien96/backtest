import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createChart, LineStyle } from "lightweight-charts";
import { STRATEGIES, STRATEGY_MAP, getDefaultParams } from "./src/strategies/index.js";
import { runBacktest } from "./src/backtest/engine.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { label: "1D", days: 1 },
  { label: "5D", days: 5 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "YTD", days: null },
  { label: "1Y", days: 365 },
  { label: "All", days: null },
];

const THEME = {
  bgPrimary: "#131722",
  bgSecondary: "#1e222d",
  bgTertiary: "#2a2e39",
  textPrimary: "#d1d4dc",
  textSecondary: "#787b86",
  border: "#363a45",
  green: "#22ab94",
  red: "#f23645",
  blue: "#2962ff",
};

const PREFETCH_THRESHOLD = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeList(list) {
  return [...list].reverse().map((c) => ({
    timestamp: parseInt(c[0]),
    time: Math.floor(parseInt(c[0]) / 1000),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

function formatDateTime(timestampMs) {
  if (!timestampMs) return "—";
  return new Date(timestampMs).toLocaleString("en-US", {
    month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function formatPrice(val) {
  if (val == null) return "—";
  return val.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatPnL(val, percent) {
  if (val == null) return "—";
  const sign = val >= 0 ? "+" : "";
  return `${sign}${formatPrice(val)} (${sign}${percent?.toFixed(2)}%)`;
}

// ─── Hook: candle data + load more ───────────────────────────────────────────
function useCandleData(symbol = "BTCUSDT", interval = "15") {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    loadingMoreRef.current = false;
    hasMoreRef.current = true;
    try {
      const url = `https://api.bybit.com/v5/market/kline?symbol=${symbol}&category=linear&interval=${interval}&limit=1000`;
      const res = await window.fetch(url);
      const data = await res.json();
      if (data.retCode !== 0) throw new Error(data.retMsg);
      const list = data.result.list;
      if (list.length < 1000) hasMoreRef.current = false;
      setCandles(normalizeList(list));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, interval]);

  const fetchMore = useCallback(async (beforeTimestampMs) => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const url = `https://api.bybit.com/v5/market/kline?symbol=${symbol}&category=linear&interval=${interval}&limit=1000&end=${beforeTimestampMs - 1}`;
      const res = await window.fetch(url);
      const data = await res.json();
      if (data.retCode !== 0) return;
      const list = data.result.list;
      if (list.length < 1000) hasMoreRef.current = false;
      if (list.length === 0) return;
      const older = normalizeList(list);
      setCandles((prev) => {
        // Filter candles đã có để tránh trùng lặp khi race condition
        const prevOldestTime = prev.length > 0 ? prev[0].time : Infinity;
        const filtered = older.filter((c) => c.time < prevOldestTime);
        return filtered.length > 0 ? [...filtered, ...prev] : prev;
      });
    } catch {
      // silent
    } finally {
      loadingMoreRef.current = false;
    }
  }, [symbol, interval]);

  useEffect(() => { fetchInitial(); }, [fetchInitial]);

  return { candles, loading, error, refetch: fetchInitial, fetchMore, hasMoreRef, loadingMoreRef };
}

// ─── Component: StrategyControls ─────────────────────────────────────────────
function StrategyControls({ selectedId, params, onStrategyChange, onParamChange }) {
  const strategy = STRATEGY_MAP[selectedId];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 14px", borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0, flexWrap: "wrap" }}>
      {/* Strategy selector */}
      <select
        value={selectedId}
        onChange={(e) => onStrategyChange(e.target.value)}
        style={{ background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "3px 8px", fontSize: 12, cursor: "pointer" }}
      >
        {STRATEGIES.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>

      {/* Auto-generated param inputs */}
      {Object.entries(strategy.paramSchema).map(([key, schema]) => (
        <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
          {schema.label}
          {schema.type === "number" && (
            <input
              type="number"
              value={params[key]}
              min={schema.min}
              max={schema.max}
              onChange={(e) => onParamChange(key, Number(e.target.value))}
              style={{ width: 52, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
            />
          )}
        </label>
      ))}
    </div>
  );
}

// ─── Component: CandlestickChart ─────────────────────────────────────────────
function CandlestickChart({ candles, trades, fetchMore, hasMoreRef, loadingMoreRef }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volSeriesRef = useRef(null);
  const priceLineRef = useRef(null);
  const isFirstDataRef = useRef(true);

  const candlesRef = useRef(candles);
  const fetchMoreRef = useRef(fetchMore);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { fetchMoreRef.current = fetchMore; }, [fetchMore]);

  const [hoveredBar, setHoveredBar] = useState(null);
  const [activeTimeframe, setActiveTimeframe] = useState("5D");

  // ── Init chart một lần ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight,
      layout: {
        background: { color: THEME.bgPrimary },
        textColor: THEME.textPrimary,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
      },
      grid: { vertLines: { color: THEME.bgSecondary }, horzLines: { color: THEME.bgSecondary } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: THEME.border },
      timeScale: { borderColor: THEME.border, timeVisible: true, secondsVisible: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: THEME.green, downColor: THEME.red,
      borderUpColor: THEME.green, borderDownColor: THEME.red,
      wickUpColor: THEME.green, wickDownColor: THEME.red,
    });

    const volSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      if (param.time) {
        const bar = param.seriesData?.get(candleSeries);
        if (bar) setHoveredBar(bar);
      } else {
        setHoveredBar(null);
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      if (range.from < PREFETCH_THRESHOLD) {
        const oldest = candlesRef.current[0];
        if (oldest) fetchMoreRef.current(oldest.timestamp);
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.offsetWidth, containerRef.current.offsetHeight);
    });
    ro.observe(containerRef.current);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;

    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  // ── Cập nhật candle data ────────────────────────────────────────────────────
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volSeriesRef.current;
    const chart = chartRef.current;
    if (!cs || !vs || candles.length === 0) return;

    cs.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    vs.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? `${THEME.green}55` : `${THEME.red}55` })));

    if (priceLineRef.current) cs.removePriceLine(priceLineRef.current);
    priceLineRef.current = cs.createPriceLine({
      price: candles[candles.length - 1].close,
      color: THEME.textSecondary,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
    });

    if (isFirstDataRef.current && chart) {
      chart.timeScale().fitContent();
      isFirstDataRef.current = false;
    }
  }, [candles]);

  // ── Cập nhật signal markers ─────────────────────────────────────────────────
  // Derive markers from trades (not raw signals) to avoid spurious markers
  // from signals the engine ignored (same-direction, no pyramiding).
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    const markers = trades.map((trade) => ({
      time: Math.floor(trade.entryTimestamp / 1000),
      position: trade.type === "Long" ? "belowBar" : "aboveBar",
      color: trade.type === "Long" ? THEME.blue : THEME.red,
      shape: trade.type === "Long" ? "arrowUp" : "arrowDown",
      text: trade.entrySignal,
    }));

    markers.sort((a, b) => a.time - b.time);
    cs.setMarkers(markers);
  }, [trades]);

  // ── Timeframe buttons ────────────────────────────────────────────────────────
  const handleTimeframe = useCallback((tf) => {
    setActiveTimeframe(tf.label);
    const chart = chartRef.current;
    if (!chart) return;

    if (tf.label === "All") { chart.timeScale().fitContent(); return; }

    const nowSec = Math.floor(Date.now() / 1000);
    let fromSec = tf.label === "YTD"
      ? Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000)
      : nowSec - tf.days * 24 * 3600;

    if (candles.length > 0) fromSec = Math.max(fromSec, candles[0].time);
    chart.timeScale().setVisibleRange({ from: fromSec, to: nowSec });
  }, [candles]);

  const displayBar = hoveredBar ?? (candles.length > 0 ? candles[candles.length - 1] : null);
  const barUp = displayBar ? displayBar.close >= displayBar.open : true;
  const barColor = barUp ? THEME.green : THEME.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: THEME.bgPrimary }}>
      {/* Header */}
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 16, borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0, userSelect: "none" }}>
        <span style={{ color: THEME.textPrimary, fontWeight: 700, fontSize: 13 }}>BTCUSDT · 15m</span>
        {displayBar && (
          <div style={{ display: "flex", gap: 10, fontSize: 12, fontFamily: "'Source Code Pro', monospace" }}>
            {[["O", displayBar.open], ["H", displayBar.high], ["L", displayBar.low], ["C", displayBar.close]].map(([label, val]) => (
              <span key={label} style={{ color: THEME.textSecondary }}>
                {label} <span style={{ color: barColor }}>{val?.toFixed(1)}</span>
              </span>
            ))}
            {displayBar.volume != null && (
              <span style={{ color: THEME.textSecondary }}>Vol <span style={{ color: THEME.textPrimary }}>{displayBar.volume?.toFixed(2)}</span></span>
            )}
          </div>
        )}
        <div style={{ marginLeft: "auto", fontSize: 11, color: THEME.textSecondary }}>
          {loadingMoreRef.current && "Tải thêm..."}
          {!hasMoreRef.current && candles.length > 0 && "Đã tải hết"}
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} style={{ flex: 1, position: "relative" }} />

      {/* Timeframe selector */}
      <div style={{ display: "flex", gap: 2, padding: "6px 12px", borderTop: `1px solid ${THEME.bgSecondary}`, flexShrink: 0 }}>
        {TIMEFRAMES.map((tf) => {
          const active = activeTimeframe === tf.label;
          return (
            <button key={tf.label} onClick={() => handleTimeframe(tf)} style={{ padding: "3px 9px", fontSize: 12, background: active ? THEME.bgTertiary : "transparent", color: active ? THEME.textPrimary : THEME.textSecondary, border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: active ? 600 : 400 }}>
              {tf.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Component: TradeTable ────────────────────────────────────────────────────
function TradeTable({ trades }) {
  if (trades.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: THEME.textSecondary, fontSize: 13 }}>
        Chưa có tín hiệu giao dịch
      </div>
    );
  }

  const sorted = [...trades].reverse(); // newest first

  const colStyle = { padding: "6px 10px", fontSize: 11, whiteSpace: "nowrap" };
  const thStyle = { ...colStyle, color: THEME.textSecondary, fontWeight: 500, background: THEME.bgSecondary, position: "sticky", top: 0, zIndex: 1 };

  return (
    <div style={{ overflowY: "auto", height: "100%" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "90px" }} />
          <col style={{ width: "55px" }} />
          <col style={{ width: "155px" }} />
          <col style={{ width: "90px" }} />
          <col style={{ width: "105px" }} />
          <col style={{ width: "100px" }} />
          <col style={{ width: "145px" }} />
          <col style={{ width: "130px" }} />
          <col style={{ width: "130px" }} />
          <col style={{ width: "130px" }} />
        </colgroup>
        <thead>
          <tr>
            {["Trade #", "Type", "Date & Time", "Signal", "Price", "Qty / Value", "Net P&L", "MFE", "MAE", "Cum. P&L"].map((h) => (
              <th key={h} style={{ ...thStyle, textAlign: "left", borderBottom: `1px solid ${THEME.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((trade) => {
            const pnlColor = trade.netPnL >= 0 ? THEME.green : THEME.red;
            const cumColor = trade.cumulativePnL >= 0 ? THEME.green : THEME.red;
            const badgeColor = trade.type === "Long" ? THEME.blue : THEME.red;
            const rowBg = THEME.bgPrimary;
            const rowBgAlt = `${THEME.bgSecondary}88`;

            return (
              <>
                {/* Row 1: Exit */}
                <tr key={`${trade.tradeNumber}-exit`} style={{ background: rowBgAlt, borderTop: `1px solid ${THEME.border}` }}>
                  <td style={{ ...colStyle, verticalAlign: "middle" }} rowSpan={2}>
                    <div style={{ fontWeight: 600, color: THEME.textPrimary, fontSize: 12 }}>#{trade.tradeNumber}</div>
                    <div style={{ color: badgeColor, fontSize: 10, fontWeight: 600 }}>{trade.type.toUpperCase()}</div>
                  </td>
                  <td style={{ ...colStyle, color: THEME.textSecondary }}>Exit</td>
                  <td style={{ ...colStyle, color: THEME.textPrimary }}>
                    {trade.isOpen ? <span style={{ color: THEME.textSecondary }}>Open</span> : formatDateTime(trade.exitTimestamp)}
                  </td>
                  <td style={{ ...colStyle, color: THEME.textSecondary }}>
                    {trade.isOpen ? <span style={{ color: THEME.textSecondary }}>Open</span> : (trade.exitSignal ?? "—")}
                  </td>
                  <td style={{ ...colStyle, color: THEME.textPrimary, textAlign: "right" }}>
                    {trade.isOpen
                      ? <span style={{ color: THEME.textSecondary }}>—</span>
                      : <>{formatPrice(trade.exitPrice)} <span style={{ color: THEME.textSecondary, fontSize: 10 }}>USDT</span></>}
                  </td>
                  {/* Span rows */}
                  <td style={{ ...colStyle, textAlign: "center", color: THEME.textPrimary }} rowSpan={2}>
                    {trade.positionSize} <span style={{ color: THEME.textSecondary, fontSize: 10 }}>/ {(trade.positionValue / 1000).toFixed(1)}K</span>
                  </td>
                  <td style={{ ...colStyle, textAlign: "right", color: pnlColor }} rowSpan={2}>
                    {trade.isOpen ? <span style={{ color: THEME.textSecondary }}>unrealized</span> : null}
                    <div>{trade.netPnL >= 0 ? "+" : ""}{formatPrice(trade.netPnL)}</div>
                    <div style={{ fontSize: 10 }}>{trade.netPnL >= 0 ? "+" : ""}{trade.netPnLPercent?.toFixed(2)}%</div>
                  </td>
                  <td style={{ ...colStyle, textAlign: "right", color: THEME.green }} rowSpan={2}>
                    <div>+{formatPrice(trade.favorableExcursion)}</div>
                    <div style={{ fontSize: 10 }}>+{trade.favorableExcursionPercent?.toFixed(2)}%</div>
                  </td>
                  <td style={{ ...colStyle, textAlign: "right", color: THEME.red }} rowSpan={2}>
                    <div>{formatPrice(trade.adverseExcursion)}</div>
                    <div style={{ fontSize: 10 }}>{trade.adverseExcursionPercent?.toFixed(2)}%</div>
                  </td>
                  <td style={{ ...colStyle, textAlign: "right", color: cumColor }} rowSpan={2}>
                    <div>{trade.cumulativePnL >= 0 ? "+" : ""}{formatPrice(trade.cumulativePnL)}</div>
                    <div style={{ fontSize: 10 }}>{trade.cumulativePnLPercent?.toFixed(2)}%</div>
                  </td>
                </tr>

                {/* Row 2: Entry */}
                <tr key={`${trade.tradeNumber}-entry`} style={{ background: rowBg }}>
                  <td style={{ ...colStyle, color: THEME.textSecondary }}>Entry</td>
                  <td style={{ ...colStyle, color: THEME.textPrimary }}>{formatDateTime(trade.entryTimestamp)}</td>
                  <td style={{ ...colStyle, color: THEME.textSecondary }}>{trade.entrySignal}</td>
                  <td style={{ ...colStyle, color: THEME.textPrimary, textAlign: "right" }}>
                    {formatPrice(trade.entryPrice)} <span style={{ color: THEME.textSecondary, fontSize: 10 }}>USDT</span>
                  </td>
                </tr>
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Component: StatCard ─────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: THEME.bgTertiary, borderRadius: 6, padding: "10px 12px", border: `1px solid ${THEME.border}` }}>
      <div style={{ fontSize: 11, color: THEME.textSecondary, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color ?? THEME.textPrimary, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: THEME.textSecondary, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── Component: EquityChart (SVG) ─────────────────────────────────────────────
function EquityChart({ trades }) {
  const [hoverIdx, setHoverIdx] = useState(null); // index vào equityData (0 = start)

  // equityData[0] = điểm khởi đầu (0), equityData[i+1] = sau trade i
  const equityData = [
    { cumPnL: 0, trade: null },
    ...trades.map((t) => ({ cumPnL: t.cumulativePnL, trade: t })),
  ];

  const eqMin = Math.min(...equityData.map((d) => d.cumPnL));
  const eqMax = Math.max(...equityData.map((d) => d.cumPnL));
  const eqRange = eqMax - eqMin || 1;

  const W = 1000, H = 170;
  const PAD = { top: 14, right: 14, bottom: 34, left: 72 }; // bottom tăng để có chỗ x-axis
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const toX = (i) => PAD.left + (i / Math.max(equityData.length - 1, 1)) * cW;
  const toY = (v) => PAD.top + (1 - (v - eqMin) / eqRange) * cH;

  const pts = equityData.map((d, i) => [toX(i), toY(d.cumPnL)]);
  const y0 = toY(Math.max(eqMin, Math.min(0, eqMax)));
  const lineD = `M ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ")}`;
  const areaD = `M ${toX(0).toFixed(1)},${y0.toFixed(1)} L ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ")} L ${toX(equityData.length - 1).toFixed(1)},${y0.toFixed(1)} Z`;

  const lastVal = equityData[equityData.length - 1].cumPnL;

  // X-axis: chọn ~6 tick đều nhau, hiển thị thời gian exit của trade
  const xTickCount = Math.min(6, trades.length);
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.round((i / (xTickCount - 1 || 1)) * (trades.length - 1));
    const trade = trades[idx];
    const ts = trade.exitTimestamp ?? trade.entryTimestamp;
    const label = ts
      ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : `T${idx + 1}`;
    return { x: toX(idx + 1), label }; // +1 vì equityData[0] là origin
  });

  // Y-axis labels
  const yLabels = [
    { v: eqMax, label: `${eqMax >= 0 ? "+" : ""}${eqMax.toFixed(0)}` },
    { v: (eqMax + eqMin) / 2, label: `${((eqMax + eqMin) / 2) >= 0 ? "+" : ""}${((eqMax + eqMin) / 2).toFixed(0)}` },
    { v: eqMin, label: `${eqMin >= 0 ? "+" : ""}${eqMin.toFixed(0)}` },
  ];

  // Hover: tìm điểm gần nhất theo X
  const handleMouseMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * W;
    const relX = mouseX - PAD.left;
    const ratio = relX / cW;
    const idx = Math.round(ratio * (equityData.length - 1));
    setHoverIdx(Math.max(0, Math.min(equityData.length - 1, idx)));
  };

  const hovered = hoverIdx != null ? equityData[hoverIdx] : null;
  const hovX = hoverIdx != null ? toX(hoverIdx) : null;
  const hovY = hovered ? toY(hovered.cumPnL) : null;

  // Tooltip content
  const tooltipLines = hovered?.trade
    ? [
        `Trade #${hovered.trade.tradeNumber} · ${hovered.trade.type}`,
        `P&L: ${hovered.cumPnL >= 0 ? "+" : ""}${hovered.cumPnL.toFixed(1)} USDT`,
        formatDateTime(hovered.trade.exitTimestamp ?? hovered.trade.entryTimestamp),
      ]
    : [`Start`];

  // Tooltip box dimensions
  const TW = 170, TH = tooltipLines.length * 14 + 10;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", display: "block", cursor: "crosshair" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <defs>
        {/* Green gradient: PAD.top → y0 (positive area fades downward to zero) */}
        <linearGradient id="eqGradGreen" x1="0" y1={PAD.top} x2="0" y2={y0} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={THEME.green} stopOpacity="0.28" />
          <stop offset="100%" stopColor={THEME.green} stopOpacity="0" />
        </linearGradient>
        {/* Red gradient: y0 → bottom (negative area fades downward from zero) */}
        <linearGradient id="eqGradRed" x1="0" y1={y0} x2="0" y2={PAD.top + cH} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={THEME.red} stopOpacity="0" />
          <stop offset="100%" stopColor={THEME.red} stopOpacity="0.28" />
        </linearGradient>
        {/* Clip: region above zero line */}
        <clipPath id="eqClipAbove">
          <rect x={PAD.left} y={PAD.top} width={cW} height={Math.max(0, y0 - PAD.top)} />
        </clipPath>
        {/* Clip: region below zero line */}
        <clipPath id="eqClipBelow">
          <rect x={PAD.left} y={y0} width={cW} height={Math.max(0, PAD.top + cH - y0)} />
        </clipPath>
      </defs>

      {/* Y grid + labels */}
      {yLabels.map(({ v, label }) => (
        <g key={v}>
          <line x1={PAD.left} y1={toY(v)} x2={W - PAD.right} y2={toY(v)} stroke={THEME.bgPrimary} strokeWidth="1" />
          <text x={PAD.left - 6} y={toY(v) + 4} textAnchor="end" fill={THEME.textSecondary} fontSize="10">{label}</text>
        </g>
      ))}

      {/* Zero dashed line */}
      {eqMin < 0 && eqMax > 0 && (
        <line x1={PAD.left} y1={y0} x2={W - PAD.right} y2={y0} stroke={THEME.border} strokeWidth="1" strokeDasharray="4,4" />
      )}

      {/* X-axis baseline */}
      <line x1={PAD.left} y1={PAD.top + cH} x2={W - PAD.right} y2={PAD.top + cH} stroke={THEME.border} strokeWidth="1" />

      {/* X-axis ticks + labels */}
      {xTicks.map(({ x, label }, i) => (
        <g key={i}>
          <line x1={x} y1={PAD.top + cH} x2={x} y2={PAD.top + cH + 4} stroke={THEME.border} strokeWidth="1" />
          <text x={x} y={PAD.top + cH + 14} textAnchor="middle" fill={THEME.textSecondary} fontSize="10">{label}</text>
        </g>
      ))}

      {/* Green area + line: positive region (above zero) */}
      <g clipPath="url(#eqClipAbove)">
        <path d={areaD} fill="url(#eqGradGreen)" />
        <path d={lineD} fill="none" stroke={THEME.green} strokeWidth="1.5" />
      </g>

      {/* Red area + line: negative region (below zero) */}
      <g clipPath="url(#eqClipBelow)">
        <path d={areaD} fill="url(#eqGradRed)" />
        <path d={lineD} fill="none" stroke={THEME.red} strokeWidth="1.5" />
      </g>

      {/* Last value dot */}
      <circle cx={toX(equityData.length - 1)} cy={toY(lastVal)} r="3" fill={lastVal >= 0 ? THEME.green : THEME.red} />

      {/* Hover crosshair */}
      {hovered && hovX != null && (
        <g>
          {/* Vertical line */}
          <line x1={hovX} y1={PAD.top} x2={hovX} y2={PAD.top + cH} stroke={THEME.textSecondary} strokeWidth="1" strokeDasharray="3,3" />
          {/* Dot on line */}
          <circle cx={hovX} cy={hovY} r="4" fill={THEME.bgPrimary} stroke={hovered.cumPnL >= 0 ? THEME.green : THEME.red} strokeWidth="2" />
          {/* Tooltip box — flip nếu gần cạnh phải */}
          {(() => {
            const flip = hovX + TW + 12 > W - PAD.right;
            const tx = flip ? hovX - TW - 8 : hovX + 8;
            const ty = Math.max(PAD.top, Math.min(hovY - TH / 2, PAD.top + cH - TH));
            return (
              <g>
                <rect x={tx} y={ty} width={TW} height={TH} rx="4" fill={THEME.bgSecondary} stroke={THEME.border} strokeWidth="1" />
                {tooltipLines.map((line, li) => (
                  <text key={li} x={tx + 8} y={ty + 14 + li * 14} fill={li === 0 ? THEME.textPrimary : THEME.textSecondary} fontSize="10" fontWeight={li === 0 ? 600 : 400}>
                    {line}
                  </text>
                ))}
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

// ─── Component: ExcursionsChart (SVG) ────────────────────────────────────────
function ExcursionsChart({ trades }) {
  const W = 1000, H = 130;
  const PAD = { top: 14, right: 14, bottom: 20, left: 72 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const mfeMax = Math.max(...trades.map((t) => t.favorableExcursion), 1);
  const maeMax = Math.max(...trades.map((t) => Math.abs(t.adverseExcursion)), 1);
  const excMax = Math.max(mfeMax, maeMax);

  const y0 = PAD.top + cH / 2;
  const halfH = cH / 2;
  const n = trades.length;
  const barW = Math.max(1.5, cW / n - 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      {/* Y labels */}
      {[
        { y: PAD.top,      label: `+${excMax.toFixed(0)}` },
        { y: y0,           label: "0" },
        { y: PAD.top + cH, label: `-${excMax.toFixed(0)}` },
      ].map(({ y, label }) => (
        <g key={y}>
          <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke={y === y0 ? THEME.border : THEME.bgPrimary} strokeWidth="1" strokeDasharray={y === y0 ? "4,4" : "0"} />
          <text x={PAD.left - 6} y={y + 4} textAnchor="end" fill={THEME.textSecondary} fontSize="10">{label}</text>
        </g>
      ))}

      {/* MFE / MAE bars */}
      {trades.map((trade, i) => {
        const x = PAD.left + (i / n) * cW + 1;
        const mfeH = (trade.favorableExcursion / excMax) * halfH;
        const maeH = (Math.abs(trade.adverseExcursion) / excMax) * halfH;
        return (
          <g key={i}>
            <rect x={x} y={y0 - mfeH} width={barW} height={Math.max(mfeH, 0.5)} fill={`${THEME.green}99`} />
            <rect x={x} y={y0} width={barW} height={Math.max(maeH, 0.5)} fill={`${THEME.red}99`} />
          </g>
        );
      })}
    </svg>
  );
}

// ─── Component: MetricsTab ────────────────────────────────────────────────────
function MetricsTab({ trades }) {
  const closed = trades.filter((t) => !t.isOpen);

  if (closed.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: THEME.textSecondary, fontSize: 13 }}>
        Chưa có dữ liệu giao dịch
      </div>
    );
  }

  const profitable = closed.filter((t) => t.netPnL > 0);
  const losing = closed.filter((t) => t.netPnL <= 0);
  const totalPnL = closed.reduce((sum, t) => sum + t.netPnL, 0);
  const totalPnLPct = closed[closed.length - 1]?.cumulativePnLPercent ?? 0;
  const winRate = (profitable.length / closed.length) * 100;
  const avgWin = profitable.length ? profitable.reduce((s, t) => s + t.netPnL, 0) / profitable.length : 0;
  const avgLoss = losing.length ? losing.reduce((s, t) => s + t.netPnL, 0) / losing.length : 0;
  const grossProfit = profitable.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(losing.reduce((s, t) => s + t.netPnL, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  // Max drawdown từ equity curve
  let maxDD = 0, peak = 0;
  for (const t of closed) {
    if (t.cumulativePnL > peak) peak = t.cumulativePnL;
    const dd = t.cumulativePnL - peak;
    if (dd < maxDD) maxDD = dd;
  }

  const sectionLabel = (text) => (
    <div style={{ fontSize: 11, color: THEME.textSecondary, fontWeight: 600, marginBottom: 8, marginTop: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {text}
    </div>
  );

  const chartBox = { background: THEME.bgSecondary, borderRadius: 6, padding: "8px 8px 4px", border: `1px solid ${THEME.border}` };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "12px 14px" }}>
      {/* ── Summary stats ───────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <StatCard
          label="Total P&L"
          value={`${totalPnL >= 0 ? "+" : ""}${formatPrice(totalPnL)}`}
          sub={`${totalPnLPct >= 0 ? "+" : ""}${totalPnLPct.toFixed(2)}%`}
          color={totalPnL >= 0 ? THEME.green : THEME.red}
        />
        <StatCard
          label="Total Trades"
          value={closed.length}
          sub={`${profitable.length} win · ${losing.length} loss`}
        />
        <StatCard
          label="Profitable Trades"
          value={`${winRate.toFixed(1)}%`}
          sub={`Avg win ${formatPrice(avgWin)} / Avg loss ${formatPrice(avgLoss)}`}
          color={winRate >= 50 ? THEME.green : THEME.red}
        />
        <StatCard
          label="Profit Factor"
          value={isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}
          sub={`Max drawdown: ${formatPrice(maxDD)}`}
          color={profitFactor >= 1 ? THEME.green : THEME.red}
        />
      </div>

      {/* ── Equity curve ────────────────────────────────────────────────────── */}
      {sectionLabel("Equity Curve")}
      <div style={chartBox}>
        <EquityChart trades={closed} />
      </div>

      {/* ── Trade excursions ─────────────────────────────────────────────────── */}
      {sectionLabel("Trade Excursions · MFE (green) / MAE (red)")}
      <div style={{ ...chartBox, marginBottom: 12 }}>
        <ExcursionsChart trades={closed} />
      </div>
    </div>
  );
}

// ─── Component: StrategyReport ────────────────────────────────────────────────
function StrategyReport({ trades, strategyName }) {
  const [activeTab, setActiveTab] = useState("trades");

  const winTrades = trades.filter((t) => !t.isOpen && t.netPnL > 0).length;
  const closedTrades = trades.filter((t) => !t.isOpen).length;
  const totalPnL = trades.reduce((sum, t) => (!t.isOpen ? sum + t.netPnL : sum), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: THEME.bgPrimary, borderTop: `1px solid ${THEME.border}` }}>
      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0 }}>
        <span style={{ color: THEME.textPrimary, fontWeight: 600, fontSize: 13 }}>{strategyName}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11, color: THEME.textSecondary }}>
          <span>{closedTrades} trades</span>
          <span>Win rate: {closedTrades ? Math.round((winTrades / closedTrades) * 100) : 0}%</span>
          <span style={{ color: totalPnL >= 0 ? THEME.green : THEME.red, fontWeight: 600 }}>
            Total P&L: {totalPnL >= 0 ? "+" : ""}{formatPrice(totalPnL)} USDT
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0 }}>
        {[{ id: "trades", label: "List of Trades" }, { id: "metrics", label: "Metrics" }].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ padding: "7px 16px", fontSize: 12, background: "transparent", color: activeTab === tab.id ? THEME.textPrimary : THEME.textSecondary, border: "none", borderBottom: activeTab === tab.id ? `2px solid ${THEME.blue}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", fontWeight: activeTab === tab.id ? 600 : 400 }}
          >
            {tab.label}
          </button>
        ))}
        {activeTab === "trades" && trades.length > 0 && (
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(trades, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "trades.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
            style={{ marginLeft: "auto", marginRight: 10, padding: "4px 10px", fontSize: 11, background: THEME.bgTertiary, color: THEME.textSecondary, border: `1px solid ${THEME.border}`, borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
          >
            Export JSON
          </button>
        )}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "trades" && <TradeTable trades={trades} />}
        {activeTab === "metrics" && <MetricsTab trades={trades} />}
      </div>
    </div>
  );
}

// ─── Component: Loading / Error ───────────────────────────────────────────────
function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: THEME.bgPrimary, gap: 12 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: 28, height: 28, border: `3px solid ${THEME.border}`, borderTopColor: THEME.blue, borderRadius: "50%", animation: "spin 0.75s linear infinite" }} />
      <span style={{ color: THEME.textSecondary, fontSize: 13 }}>Đang tải dữ liệu BTCUSDT 15m...</span>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: THEME.bgPrimary, gap: 12 }}>
      <span style={{ color: THEME.red, fontSize: 13 }}>Lỗi: {message}</span>
      <button onClick={onRetry} style={{ padding: "6px 18px", background: THEME.blue, color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>Thử lại</button>
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const { candles, loading, error, refetch, fetchMore, hasMoreRef, loadingMoreRef } =
    useCandleData("BTCUSDT", "15");

  // Strategy state
  const [selectedStrategyId, setSelectedStrategyId] = useState(STRATEGIES[0].id);
  const [strategyParams, setStrategyParams] = useState(getDefaultParams(STRATEGIES[0]));

  // Cập nhật params khi đổi strategy
  const handleStrategyChange = (id) => {
    setSelectedStrategyId(id);
    setStrategyParams(getDefaultParams(STRATEGY_MAP[id]));
  };

  const handleParamChange = (key, val) => {
    setStrategyParams((prev) => ({ ...prev, [key]: val }));
  };

  // Chạy backtest mỗi khi candles hoặc params thay đổi
  const trades = useMemo(() => {
    if (candles.length === 0) return [];
    const strategy = STRATEGY_MAP[selectedStrategyId];
    const sigs = strategy.generateSignals(candles, strategyParams);
    return runBacktest(candles, sigs);
  }, [candles, selectedStrategyId, strategyParams]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const strategy = STRATEGY_MAP[selectedStrategyId];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: THEME.bgPrimary }}>
      {/* Strategy controls */}
      <StrategyControls
        selectedId={selectedStrategyId}
        params={strategyParams}
        onStrategyChange={handleStrategyChange}
        onParamChange={handleParamChange}
      />

      {/* Chart — 60% height */}
      <div style={{ flex: "0 0 60%", overflow: "hidden" }}>
        <CandlestickChart
          candles={candles}
          trades={trades}
          fetchMore={fetchMore}
          hasMoreRef={hasMoreRef}
          loadingMoreRef={loadingMoreRef}
        />
      </div>

      {/* Strategy report — 40% height */}
      <div style={{ flex: "0 0 40%", overflow: "hidden" }}>
        <StrategyReport trades={trades} strategyName={strategy.name} />
      </div>
    </div>
  );
}
