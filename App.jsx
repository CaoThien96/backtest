import { useState, useEffect, useRef, useCallback } from "react";
import { createChart, LineStyle } from "lightweight-charts";

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

// Ngưỡng: khi visible logical range bắt đầu < PREFETCH_THRESHOLD → fetch thêm
const PREFETCH_THRESHOLD = 50;

// ─── Normalize Bybit kline response ──────────────────────────────────────────
function normalizeList(list) {
  // list từ Bybit là newest-first → reverse
  return list.reverse().map((c) => ({
    timestamp: parseInt(c[0]),               // ms
    time: Math.floor(parseInt(c[0]) / 1000), // giây — cho lightweight-charts
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ─── Hook: quản lý candle data + load more ───────────────────────────────────
function useCandleData(symbol = "BTCUSDT", interval = "15") {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Dùng ref để tránh stale closure trong subscription callback
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

  // Fetch thêm nến trước `beforeTimestampMs`
  const fetchMore = useCallback(
    async (beforeTimestampMs) => {
      if (loadingMoreRef.current || !hasMoreRef.current) return;
      loadingMoreRef.current = true;
      try {
        // end = beforeTimestampMs - 1 để không lấy trùng nến đầu tiên hiện có
        const url = `https://api.bybit.com/v5/market/kline?symbol=${symbol}&category=linear&interval=${interval}&limit=1000&end=${beforeTimestampMs - 1}`;
        const res = await window.fetch(url);
        const data = await res.json();
        if (data.retCode !== 0) return;
        const list = data.result.list;
        if (list.length < 1000) hasMoreRef.current = false;
        if (list.length === 0) return;
        const older = normalizeList(list);
        setCandles((prev) => [...older, ...prev]);
      } catch {
        // silent — user vẫn xem được data hiện tại
      } finally {
        loadingMoreRef.current = false;
      }
    },
    [symbol, interval]
  );

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  return { candles, loading, error, refetch: fetchInitial, fetchMore, hasMoreRef, loadingMoreRef };
}

// ─── Component: CandlestickChart ─────────────────────────────────────────────
function CandlestickChart({ candles, fetchMore, hasMoreRef, loadingMoreRef }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volSeriesRef = useRef(null);
  const priceLineRef = useRef(null);
  const isFirstDataRef = useRef(true);

  // Ref để subscription callback đọc được giá trị mới nhất mà không cần re-subscribe
  const candlesRef = useRef(candles);
  const fetchMoreRef = useRef(fetchMore);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { fetchMoreRef.current = fetchMore; }, [fetchMore]);

  const [hoveredBar, setHoveredBar] = useState(null);
  const [activeTimeframe, setActiveTimeframe] = useState("5D");

  // ── Init chart MỘT LẦN ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight,
      layout: {
        background: { color: THEME.bgPrimary },
        textColor: THEME.textPrimary,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
      },
      grid: {
        vertLines: { color: THEME.bgSecondary },
        horzLines: { color: THEME.bgSecondary },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: THEME.border },
      timeScale: {
        borderColor: THEME.border,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor: THEME.green,
      downColor: THEME.red,
      borderUpColor: THEME.green,
      borderDownColor: THEME.red,
      wickUpColor: THEME.green,
      wickDownColor: THEME.red,
    });

    // Volume histogram
    const volSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // OHLCV header khi hover
    chart.subscribeCrosshairMove((param) => {
      if (param.time) {
        const bar = param.seriesData?.get(candleSeries);
        if (bar) setHoveredBar(bar);
      } else {
        setHoveredBar(null);
      }
    });

    // Scroll sang trái → load more
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      if (range.from < PREFETCH_THRESHOLD) {
        const oldest = candlesRef.current[0];
        if (oldest) fetchMoreRef.current(oldest.timestamp);
      }
    });

    // Responsive resize
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.resize(
          containerRef.current.offsetWidth,
          containerRef.current.offsetHeight
        );
      }
    });
    ro.observe(containerRef.current);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
    };
  }, []); // chỉ chạy 1 lần

  // ── Cập nhật data khi candles thay đổi ───────────────────────────────────
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volSeries = volSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volSeries || candles.length === 0) return;

    candleSeries.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    volSeries.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? `${THEME.green}55` : `${THEME.red}55`,
      }))
    );

    // Cập nhật current price line
    if (priceLineRef.current) {
      candleSeries.removePriceLine(priceLineRef.current);
    }
    priceLineRef.current = candleSeries.createPriceLine({
      price: candles[candles.length - 1].close,
      color: THEME.textSecondary,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });

    // Lần đầu có data → fitContent
    if (isFirstDataRef.current && chart) {
      chart.timeScale().fitContent();
      isFirstDataRef.current = false;
    }
  }, [candles]);

  // ── Timeframe buttons ────────────────────────────────────────────────────
  const handleTimeframe = useCallback(
    (tf) => {
      setActiveTimeframe(tf.label);
      const chart = chartRef.current;
      if (!chart) return;

      if (tf.label === "All") {
        chart.timeScale().fitContent();
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      let fromSec;

      if (tf.label === "YTD") {
        fromSec = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
      } else {
        fromSec = nowSec - tf.days * 24 * 3600;
      }

      if (candles.length > 0) {
        fromSec = Math.max(fromSec, candles[0].time);
      }

      chart.timeScale().setVisibleRange({ from: fromSec, to: nowSec });
    },
    [candles]
  );

  const displayBar =
    hoveredBar ?? (candles.length > 0 ? candles[candles.length - 1] : null);
  const barUp = displayBar ? displayBar.close >= displayBar.open : true;
  const barColor = barUp ? THEME.green : THEME.red;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: THEME.bgPrimary }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          borderBottom: `1px solid ${THEME.bgSecondary}`,
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        <span style={{ color: THEME.textPrimary, fontWeight: 700, fontSize: 13, letterSpacing: "0.02em" }}>
          BTCUSDT · 15m
        </span>

        {displayBar && (
          <div style={{ display: "flex", gap: 10, fontSize: 12, fontFamily: "'Source Code Pro', monospace" }}>
            {[["O", displayBar.open], ["H", displayBar.high], ["L", displayBar.low], ["C", displayBar.close]].map(
              ([label, val]) => (
                <span key={label} style={{ color: THEME.textSecondary }}>
                  {label} <span style={{ color: barColor }}>{val?.toFixed(1)}</span>
                </span>
              )
            )}
            {displayBar.volume != null && (
              <span style={{ color: THEME.textSecondary }}>
                Vol <span style={{ color: THEME.textPrimary }}>{displayBar.volume?.toFixed(2)}</span>
              </span>
            )}
          </div>
        )}

        {/* Loading more indicator */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {loadingMoreRef.current && (
            <>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div
                style={{
                  width: 12,
                  height: 12,
                  border: `2px solid ${THEME.border}`,
                  borderTopColor: THEME.blue,
                  borderRadius: "50%",
                  animation: "spin 0.75s linear infinite",
                }}
              />
              <span style={{ color: THEME.textSecondary, fontSize: 11 }}>Tải thêm...</span>
            </>
          )}
          {!hasMoreRef.current && candles.length > 0 && (
            <span style={{ color: THEME.textSecondary, fontSize: 11 }}>Đã tải hết dữ liệu</span>
          )}
        </div>
      </div>

      {/* ── Chart ───────────────────────────────────────────────────────────── */}
      <div ref={containerRef} style={{ flex: 1, position: "relative" }} />

      {/* ── Timeframe selector ──────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "6px 12px",
          borderTop: `1px solid ${THEME.bgSecondary}`,
          flexShrink: 0,
        }}
      >
        {TIMEFRAMES.map((tf) => {
          const active = activeTimeframe === tf.label;
          return (
            <button
              key={tf.label}
              onClick={() => handleTimeframe(tf)}
              style={{
                padding: "3px 9px",
                fontSize: 12,
                background: active ? THEME.bgTertiary : "transparent",
                color: active ? THEME.textPrimary : THEME.textSecondary,
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: active ? 600 : 400,
              }}
            >
              {tf.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Component: Loading ───────────────────────────────────────────────────────
function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: THEME.bgPrimary, gap: 12 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: 28, height: 28, border: `3px solid ${THEME.border}`, borderTopColor: THEME.blue, borderRadius: "50%", animation: "spin 0.75s linear infinite" }} />
      <span style={{ color: THEME.textSecondary, fontSize: 13 }}>Đang tải dữ liệu BTCUSDT 15m...</span>
    </div>
  );
}

// ─── Component: Error ─────────────────────────────────────────────────────────
function ErrorState({ message, onRetry }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: THEME.bgPrimary, gap: 12 }}>
      <span style={{ color: THEME.red, fontSize: 13 }}>Lỗi khi tải dữ liệu: {message}</span>
      <button onClick={onRetry} style={{ padding: "6px 18px", background: THEME.blue, color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>
        Thử lại
      </button>
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const { candles, loading, error, refetch, fetchMore, hasMoreRef, loadingMoreRef } =
    useCandleData("BTCUSDT", "15");

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  return (
    <div style={{ height: "100vh", background: THEME.bgPrimary }}>
      <CandlestickChart
        candles={candles}
        fetchMore={fetchMore}
        hasMoreRef={hasMoreRef}
        loadingMoreRef={loadingMoreRef}
      />
    </div>
  );
}
