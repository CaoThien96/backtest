import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createChart, LineStyle } from "lightweight-charts";
import { STRATEGIES, STRATEGY_MAP, getDefaultParams } from "./src/strategies/index.js";
import { runBacktest } from "./src/backtest/engine.js";
import { getProvider, PROVIDERS, DEFAULT_PROVIDER_ID } from "./src/data/providers/index.js";
import { getCandlesFromCache, upsertCandlesInCache, getCachedRange } from "./src/data/cache.js";

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

const INTERVALS = [
  { label: "5m",  value: "5"  },
  { label: "15m", value: "15" },
  { label: "30m", value: "30" },
  { label: "1h",  value: "60" },
  { label: "4h",  value: "240" },
  { label: "1d",  value: "D"  },
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

const ASSET_OPTIONS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];
const VISIBLE_PROVIDERS = PROVIDERS.filter((p) => p.id !== "kraken");
// Provider-specific symbol mapping (used for REST/WS endpoints + cache keys)
const ASSET_BY_PROVIDER_SYMBOL = {
  bybit: {
    BTC: "BTCUSDT",
    ETH: "ETHUSDT",
    BNB: "BNBUSDT",
    SOL: "SOLUSDT",
    XRP: "XRPUSDT",
    DOGE: "DOGEUSDT",
  },
  coinbase: {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    BNB: "BNB-USD",
    SOL: "SOL-USD",
    XRP: "XRP-USD",
    DOGE: "DOGE-USD",
  },
  bitstamp: {
    BTC: "btcusd",
    ETH: "ethusd",
    BNB: "bnbusd",
    SOL: "solusd",
    XRP: "xrpusd",
    DOGE: "dogeusd",
  },
  kraken: {
    // Kraken OHLC REST expects XBTUSD / XETHZUSD
    BTC: "XBTUSD",
    ETH: "XETHZUSD",
    DOGE: "XDGUSD",
  },
};

function getProviderSymbol(providerId, asset) {
  return ASSET_BY_PROVIDER_SYMBOL?.[providerId]?.[asset] ?? "BTCUSDT";
}

const PREFETCH_THRESHOLD = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function intervalToMinutes(interval) {
  if (interval === "D") return 1440;
  const n = Number(interval);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

function calcDynamicRvolForMinuteRows(minuteCandles, timeframeCandles, entryStartMs, lookback) {
  if (!lookback || lookback <= 0 || !minuteCandles.length || !timeframeCandles.length) {
    return new Array(minuteCandles.length).fill(null);
  }

  const prevTfBars = timeframeCandles
    .filter((c) => c?.timestamp < entryStartMs)
    .sort((a, b) => a.time - b.time);
  if (prevTfBars.length < lookback) return new Array(minuteCandles.length).fill(null);

  const base = prevTfBars.slice(-lookback);
  const avgVol = base.reduce((s, c) => s + (c?.volume ?? 0), 0) / lookback;
  if (!(avgVol > 0)) return new Array(minuteCandles.length).fill(null);

  const out = new Array(minuteCandles.length).fill(null);
  let cumVol = 0;
  for (let i = 0; i < minuteCandles.length; i++) {
    cumVol += minuteCandles[i]?.volume ?? 0;
    out[i] = cumVol / avgVol;
  }
  return out;
}

function sortAndClipCandlesInRange(candles, startMs, endMs) {
  const sorted = [...candles]
    .filter((c) => c?.timestamp >= startMs && c?.timestamp < endMs)
    .sort((a, b) => a.time - b.time);
  const seen = new Set();
  return sorted.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
}

function mergeCandlesByTime(candles) {
  const byTime = new Map();
  for (const c of candles) {
    if (c && typeof c.time === "number") byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function hasDenseMinuteCoverage(candles, startMs, endMs) {
  const expected = Math.max(0, Math.ceil((endMs - startMs) / 60000));
  if (expected === 0) return true;
  if (!candles?.length) return false;
  // Allow small gaps caused by exchange outages while still preferring cache reuse.
  return candles.length >= Math.max(1, expected - 2);
}

async function fetchBybitMinuteRange(startMs, endMs, symbol = "BTCUSDT") {
  const endInclusive = endMs - 1;
  const url = `https://api.bybit.com/v5/market/kline?symbol=${encodeURIComponent(symbol)}&category=linear&interval=1&limit=1000&start=${startMs}&end=${endInclusive}`;
  const res = await window.fetch(url);
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit API error");
  const list = data.result?.list ?? [];
  const normalized = [...list].reverse().map((c) => ({
    timestamp: parseInt(c[0], 10),
    time: Math.floor(parseInt(c[0], 10) / 1000),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5] ?? 0),
  }));
  return sortAndClipCandlesInRange(normalized, startMs, endMs);
}

async function fetchMinuteRangeByProvider(providerId, startMs, endMs, symbol = "BTCUSDT") {
  if (providerId === "kraken") return [];
  if (providerId === "bybit") {
    return fetchBybitMinuteRange(startMs, endMs, symbol);
  }
  if (providerId === "coinbase") {
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs - 1).toISOString();
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await window.fetch(url);
    if (!res.ok) throw new Error(`Coinbase API: ${res.status}`);
    const list = await res.json();
    const normalized = Array.isArray(list)
      ? [...list].reverse().map((c) => ({
          timestamp: parseInt(c[0], 10) * 1000,
          time: parseInt(c[0], 10),
          open: parseFloat(c[3]),
          high: parseFloat(c[2]),
          low: parseFloat(c[1]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5] ?? 0),
        }))
      : [];
    return sortAndClipCandlesInRange(normalized, startMs, endMs);
  }
  if (providerId === "bitstamp") {
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor((endMs - 1) / 1000);
    const url = `https://www.bitstamp.net/api/v2/ohlc/${encodeURIComponent(symbol)}/?step=60&limit=1000&start=${startSec}&end=${endSec}`;
    const res = await window.fetch(url);
    if (!res.ok) throw new Error(`Bitstamp API: ${res.status}`);
    const data = await res.json();
    const ohlc = data?.data?.ohlc ?? [];
    const normalized = ohlc.map((c) => {
      const t = parseInt(c.timestamp, 10);
      return {
        timestamp: t * 1000,
        time: t,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume ?? 0),
      };
    });
    return sortAndClipCandlesInRange(normalized, startMs, endMs);
  }
  if (providerId === "kraken") {
    const sinceSec = Math.floor(startMs / 1000);
    const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=1&since=${sinceSec}`;
    const res = await window.fetch(url);
    const data = await res.json();
    if (data.error && data.error.length) throw new Error(data.error.join(" ") || "Kraken API error");
    const result = data.result ?? {};
    const key = Object.keys(result).find((k) => k !== "last");
    const rows = key ? result[key] ?? [] : [];
    const normalized = rows.map((c) => {
      const t = parseInt(c[0], 10);
      return {
        timestamp: t * 1000,
        time: t,
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[6] ?? 0),
      };
    });
    return sortAndClipCandlesInRange(normalized, startMs, endMs);
  }
  return [];
}

async function loadMinuteRangeCached({
  providerId,
  symbol,
  startMs,
  endMs,
  inMemoryRef,
}) {
  const cacheKey = `${providerId}:${symbol}:1m`;
  const mergedMemory = inMemoryRef.current.get(cacheKey);
  if (mergedMemory?.length) {
    const clipped = sortAndClipCandlesInRange(mergedMemory, startMs, endMs);
    if (hasDenseMinuteCoverage(clipped, startMs, endMs)) {
      return { candles: clipped, source: "memory-cache" };
    }
  }

  const local = getCandlesFromCache(providerId, "1", symbol);
  const localClip = sortAndClipCandlesInRange(local, startMs, endMs);
  if (hasDenseMinuteCoverage(localClip, startMs, endMs)) {
    inMemoryRef.current.set(cacheKey, mergeCandlesByTime([...(mergedMemory ?? []), ...local]));
    return { candles: localClip, source: "local-cache" };
  }

  let fetched = [];
  let source = providerId;
  try {
    fetched = await fetchMinuteRangeByProvider(providerId, startMs, endMs, symbol);
  } catch {
    fetched = [];
  }
  if (!fetched.length && providerId !== "bybit") {
    source = "bybit";
    fetched = await fetchBybitMinuteRange(startMs, endMs, symbol);
  }

  if (fetched.length) {
    upsertCandlesInCache(providerId, "1", symbol, fetched);
    const combined = mergeCandlesByTime([...(mergedMemory ?? []), ...local, ...fetched]);
    inMemoryRef.current.set(cacheKey, combined);
    return { candles: sortAndClipCandlesInRange(combined, startMs, endMs), source };
  }

  const fallback = sortAndClipCandlesInRange([...(mergedMemory ?? []), ...local], startMs, endMs);
  return { candles: fallback, source: fallback.length ? "cache-partial" : source };
}

// ─── Hook: throttle a value (max 1 update per `delay` ms) ────────────────────
function useThrottle(value, delay) {
  const [throttled, setThrottled] = useState(value);
  const lastUpdated = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdated.current;
    if (elapsed >= delay) {
      lastUpdated.current = now;
      setThrottled(value);
    } else {
      const timer = setTimeout(() => {
        lastUpdated.current = Date.now();
        setThrottled(value);
      }, delay - elapsed);
      return () => clearTimeout(timer);
    }
  }, [value, delay]);
  return throttled;
}

// ─── Hook: candle data + load more (provider-driven) ──────────────────────────
function useCandleData(providerId = DEFAULT_PROVIDER_ID, interval = "15", symbolOverride) {
  const provider = getProvider(providerId);
  const symbol = symbolOverride ?? provider?.getSymbol?.() ?? "BTCUSDT";
  const [candles, setCandles] = useState([]);
  const [liveCandle, setLiveCandle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);

  const wsRef = useRef(null);
  const pingRef = useRef(null);
  const reconnectRef = useRef(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);
  const liveCandleRef = useRef(liveCandle);
  const candlesRef = useRef(candles);
  useEffect(() => { liveCandleRef.current = liveCandle; }, [liveCandle]);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  const fetchInitial = useCallback(async () => {
    setLiveCandle(null);
    setLoading(true);
    setError(null);
    loadingMoreRef.current = false;
    hasMoreRef.current = true;
    const cached = getCandlesFromCache(providerId, interval, symbol);
    if (cached.length > 0) setCandles(cached);
    try {
      const { list, hasMore } = await provider.fetchInitial(interval, symbol);
      hasMoreRef.current = hasMore;
      setCandles(list);
      if (list.length > 0) upsertCandlesInCache(providerId, interval, symbol, list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [providerId, interval, symbol]);

  const fetchMore = useCallback(async (beforeTimestampMs) => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const beforeSec = Math.floor(beforeTimestampMs / 1000);
    const current = candlesRef.current;
    const oldestInView = current.length > 0 ? current[0].time : Infinity;
    let fromCache = getCandlesFromCache(providerId, interval, symbol).filter(
      (c) => c.time < beforeSec && c.time < oldestInView
    );
    const CACHE_FETCH_MORE_LIMIT = 1000;
    if (fromCache.length > CACHE_FETCH_MORE_LIMIT) {
      fromCache = fromCache.slice(-CACHE_FETCH_MORE_LIMIT);
    }
    if (fromCache.length > 0) {
      const range = getCachedRange(providerId, interval, symbol);
      // Cache range only tells what we have locally, not what exists remotely.
      // Do not set hasMore=false here, otherwise we can block the API fetch
      // once we hit the oldest cached candle.
      if (range != null && range.from < fromCache[0].time) {
        hasMoreRef.current = true;
      }
      setCandles((prev) => {
        const prevOldest = prev.length > 0 ? prev[0].time : Infinity;
        const filtered = fromCache.filter((c) => c.time < prevOldest);
        return filtered.length > 0 ? [...filtered, ...prev] : prev;
      });
      return;
    }
    loadingMoreRef.current = true;
    try {
      const { list, hasMore } = await provider.fetchMore(interval, beforeTimestampMs, symbol);
      hasMoreRef.current = hasMore;
      if (list.length > 0) {
        upsertCandlesInCache(providerId, interval, symbol, list);
        setCandles((prev) => {
          const prevOldestTime = prev.length > 0 ? prev[0].time : Infinity;
          const filtered = list.filter((c) => c.time < prevOldestTime);
          return filtered.length > 0 ? [...filtered, ...prev] : prev;
        });
      }
    } catch {
      // silent
    } finally {
      loadingMoreRef.current = false;
    }
  }, [providerId, interval, symbol]);

  useEffect(() => { fetchInitial(); }, [fetchInitial]);

  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimeout(reconnectRef.current);
    const useWs = provider.wsSupportsInterval && provider.wsSupportsInterval(interval);
    if (!useWs) return;

    const ws = new WebSocket(provider.wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const payloads = provider.getWsSubscribePayload(interval, symbol);
      if (Array.isArray(payloads)) {
        payloads.forEach((p) => ws.send(JSON.stringify(p)));
      } else if (payloads) {
        ws.send(JSON.stringify(payloads));
      }
      backoffRef.current = 1000;
      const pingInterval = provider.startWsPing?.(ws);
      if (pingInterval != null) pingRef.current = pingInterval;
    };

    ws.onmessage = (event) => {
      const parsed = provider.parseWsMessage(event.data);
      if (!parsed?.candle) return;
      const { candle, confirm } = parsed;
      const prevLive = liveCandleRef.current;
      const isNewTime = prevLive && prevLive.time !== candle.time;

      if (confirm) {
        setCandles((prev) => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if (candle.time === last.time) return [...prev.slice(0, -1), candle];
          if (candle.time > last.time) return [...prev, candle];
          return prev;
        });
        setLiveCandle(null);
      } else if (isNewTime) {
        setCandles((prev) => {
          const last = prev[prev.length - 1];
          if (last?.time === prevLive.time) return [...prev.slice(0, -1), prevLive];
          return [...prev, prevLive];
        });
        setLiveCandle(candle);
      } else {
        setLiveCandle(candle);
      }
    };

    ws.onclose = () => {
      if (pingRef.current) clearInterval(pingRef.current);
      pingRef.current = null;
      if (!mountedRef.current) return;
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, 30000);
      reconnectRef.current = setTimeout(connectWs, delay);
    };

    ws.onerror = () => ws.close();
  }, [providerId, interval, symbol]);

  useEffect(() => {
    mountedRef.current = true;
    if (provider.wsSupportsInterval?.(interval)) connectWs();
    return () => {
      mountedRef.current = false;
      if (pingRef.current) clearInterval(pingRef.current);
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs]);

  return { candles, liveCandle, loading, error, refetch: fetchInitial, fetchMore, hasMoreRef, loadingMoreRef, provider };
}

// ─── Component: StrategyControls ─────────────────────────────────────────────
function StrategyControls({
  selectedId,
  params,
  onStrategyChange,
  onParamChange,
  positionSize,
  onPositionSizeChange,
  feePct,
  onFeePctChange,
  partialThresholdPct,
  onPartialThresholdPctChange,
  partialCloseRatioPct,
  onPartialCloseRatioPctChange,
  trailEnabled,
  onTrailEnabledChange,
  trailPct,
  onTrailPctChange,
  minFePct,
  onMinFePctChange,
  prpEntryPriceMode,
  onPrpEntryPriceModeChange,
}) {
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

      {/* Position size */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
        Position (USDT)
        <input
          type="number"
          value={positionSize}
          min={1}
          step={1000}
          onChange={(e) => onPositionSizeChange(Number(e.target.value))}
          style={{ width: 72, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
        />
      </label>

      {/* Fee per side (% of position value) */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
        Fee % mỗi chiều
        <input
          type="number"
          value={feePct}
          min={0}
          max={2}
          step={0.01}
          onChange={(e) => onFeePctChange(Math.max(0, Math.min(2, Number(e.target.value))))}
          style={{ width: 52, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
        />
      </label>

      {/* Chốt lời: threshold % + tỷ lệ chốt % */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
        Chốt lời khi lời (%)
        <input
          type="number"
          value={partialThresholdPct}
          min={0}
          max={100}
          step={0.1}
          onChange={(e) => onPartialThresholdPctChange(Math.max(0, Number(e.target.value)))}
          style={{ width: 52, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
        />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
        Tỷ lệ chốt (%)
        <input
          type="number"
          value={partialCloseRatioPct}
          min={0}
          max={100}
          step={1}
          onChange={(e) => onPartialCloseRatioPctChange(Math.max(0, Math.min(100, Number(e.target.value))))}
          style={{ width: 52, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
        />
      </label>

      {/* Divider */}
      <div style={{ width: 1, height: 14, background: THEME.border }} />

      {/* Trailing Stop */}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={trailEnabled}
          onChange={(e) => onTrailEnabledChange(e.target.checked)}
          style={{ accentColor: THEME.blue, cursor: "pointer" }}
        />
        Trail %
      </label>
      {trailEnabled && (
        <>
          <input
            type="number"
            value={trailPct}
            min={0.1}
            max={99}
            step={0.1}
            onChange={(e) => onTrailPctChange(Math.max(0.1, Math.min(99, Number(e.target.value))))}
            style={{ width: 44, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
            Min FE%
            <input
              type="number"
              value={minFePct}
              min={0.1}
              max={50}
              step={0.1}
              onChange={(e) => onMinFePctChange(Math.max(0.1, Number(e.target.value)))}
              style={{ width: 44, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
            />
          </label>
        </>
      )}

      {/* Divider */}
      <div style={{ width: 1, height: 14, background: THEME.border }} />

      {selectedId === "prp-pivot-psar" && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: THEME.textSecondary }}>
          Entry Price Mode
          <select
            value={prpEntryPriceMode}
            onChange={(e) => onPrpEntryPriceModeChange(e.target.value)}
            style={{ background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, cursor: "pointer" }}
          >
            <option value="Legacy">Legacy (Old)</option>
            <option value="Actual">Actual (1m RVOL)</option>
          </select>
        </label>
      )}

      {selectedId === "prp-pivot-psar" && <div style={{ width: 1, height: 14, background: THEME.border }} />}

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
              step={schema.step ?? 1}
              onChange={(e) => onParamChange(key, Number(e.target.value))}
              style={{ width: 52, background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, textAlign: "center" }}
            />
          )}
          {schema.type === "select" && (
            <select
              value={params[key]}
              onChange={(e) => onParamChange(key, e.target.value)}
              style={{ background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 12, cursor: "pointer" }}
            >
              {schema.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </label>
      ))}
    </div>
  );
}

// ─── Component: CandlestickChart ─────────────────────────────────────────────
function CandlestickChart({
  candles,
  trades,
  liveCandle,
  fetchMore,
  hasMoreRef,
  loadingMoreRef,
  selectedInterval,
  onIntervalChange,
  selectedProviderId,
  onProviderChange,
  selectedAsset,
  onAssetChange,
  symbolLabel,
  pendingBuy,
  pendingSell,
  activeStopLoss,
  activeTakeProfit,
  pivotHighPrice,
  pivotLowPrice,
  pivotHighTime,
  pivotLowTime,
  currentRvol,
}) {
  // Safety: ensure we never keep an invalid provider id when Kraken is hidden.
  useEffect(() => {
    const visibleIds = new Set(VISIBLE_PROVIDERS.map((p) => p.id));
    if (visibleIds.has(selectedProviderId)) return;
    const fallbackId = VISIBLE_PROVIDERS[0]?.id ?? DEFAULT_PROVIDER_ID;
    if (fallbackId !== selectedProviderId) onProviderChange?.(fallbackId);
  }, [selectedProviderId, onProviderChange]);

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volSeriesRef = useRef(null);
  const priceLineRef = useRef(null);
  const pendingBuyLineRef = useRef(null);
  const pendingSellLineRef = useRef(null);
  const pivotHighLineRef = useRef(null);
  const pivotLowLineRef = useRef(null);
  const slLineRef = useRef(null);
  const tpLineRef = useRef(null);
  const isFirstDataRef = useRef(true);
  const [entryMarkerPositions, setEntryMarkerPositions] = useState([]); // { x, y, type } for overlay triangles
  const [overlayKey, setOverlayKey] = useState(0);
  const [overlaySize, setOverlaySize] = useState({ w: 0, h: 0 });

  const candlesRef = useRef(candles);
  const lastChartTimeRef = useRef(null); // last time in chart (set when we setData); update() only allowed if live >= this
  const fetchMoreRef = useRef(fetchMore);
  const liveCandleRef = useRef(liveCandle);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { fetchMoreRef.current = fetchMore; }, [fetchMore]);
  useEffect(() => { liveCandleRef.current = liveCandle; }, [liveCandle]);

  const [hoveredTime, setHoveredTime] = useState(null);
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

    chart.timeScale().subscribeVisibleTimeRangeChange(() => setOverlayKey((k) => k + 1));

    chart.subscribeCrosshairMove((param) => {
      if (param.time) {
        const t = typeof param.time === "number" ? param.time : null;
        setHoveredTime(t);
      } else {
        setHoveredTime(null);
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

    // Ensure asc order and unique times (lightweight-charts requirement; fixes 1d / fetchMore ordering)
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const seen = new Set();
    const ordered = sorted.filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    cs.setData(ordered.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    vs.setData(ordered.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? `${THEME.green}55` : `${THEME.red}55` })));

    const lastTime = ordered[ordered.length - 1]?.time ?? null;
    lastChartTimeRef.current = lastTime;

    // Restore live bar if present (setData wipes it)
    // Guard: skip if live candle is stale from a previous interval
    const live = liveCandleRef.current;
    const liveValid = live && lastTime != null && live.time >= lastTime;
    if (liveValid) {
      cs.update({ time: live.time, open: live.open, high: live.high, low: live.low, close: live.close });
      vs.update({ time: live.time, value: live.volume, color: live.close >= live.open ? `${THEME.green}55` : `${THEME.red}55` });
    }

    if (priceLineRef.current) cs.removePriceLine(priceLineRef.current);
    priceLineRef.current = cs.createPriceLine({
      price: (liveValid ? live : ordered[ordered.length - 1]).close,
      color: THEME.textSecondary,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      // Disable axis label here to avoid duplicating the candle series last-value label
      // (which is shown with green/red depending on candle direction).
      axisLabelVisible: false,
    });

    if (isFirstDataRef.current && chart) {
      chart.timeScale().fitContent();
      isFirstDataRef.current = false;
    }
  }, [candles]);

  // ── Live candle incremental update (WS tick) ─────────────────────────────────
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volSeriesRef.current;
    if (!cs || !vs || !liveCandle) return;
    // Don't update when chart has no data (e.g. loading after interval change)
    if (candlesRef.current.length === 0) return;

    // lightweight-charts: update() only allows same time (update last bar) or newer (append). Never older.
    const lastInChart = lastChartTimeRef.current;
    if (lastInChart != null && liveCandle.time < lastInChart) return;

    cs.update({ time: liveCandle.time, open: liveCandle.open, high: liveCandle.high, low: liveCandle.low, close: liveCandle.close });
    vs.update({ time: liveCandle.time, value: liveCandle.volume, color: liveCandle.close >= liveCandle.open ? `${THEME.green}55` : `${THEME.red}55` });
    lastChartTimeRef.current = liveCandle.time;

    // Keep price line on latest live price
    if (priceLineRef.current) {
      cs.removePriceLine(priceLineRef.current);
      priceLineRef.current = cs.createPriceLine({
        price: liveCandle.close,
        color: THEME.textSecondary,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
    }
  }, [liveCandle]);

  // ── Cập nhật signal markers ─────────────────────────────────────────────────
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

    if (typeof pivotHighTime === "number" && Number.isFinite(pivotHighTime)) {
      markers.push({
        time: pivotHighTime,
        position: "aboveBar",
        color: "#E9A23B",
        shape: "circle",
        text: "ph",
      });
    }
    if (typeof pivotLowTime === "number" && Number.isFinite(pivotLowTime)) {
      markers.push({
        time: pivotLowTime,
        position: "belowBar",
        color: "#5FA8FF",
        shape: "circle",
        text: "pl",
      });
    }

    markers.sort((a, b) => a.time - b.time);
    cs.setMarkers(markers);
  }, [trades, pivotHighTime, pivotLowTime]);

  // ── Pending buy/sell price lines ─────────────────────────────────────────────
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    if (pendingBuyLineRef.current) {
      cs.removePriceLine(pendingBuyLineRef.current);
      pendingBuyLineRef.current = null;
    }
    if (pendingBuy != null && typeof pendingBuy === "number") {
      pendingBuyLineRef.current = cs.createPriceLine({
        price: pendingBuy,
        color: THEME.green,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Pending buy",
      });
    }

    if (pendingSellLineRef.current) {
      cs.removePriceLine(pendingSellLineRef.current);
      pendingSellLineRef.current = null;
    }
    if (pendingSell != null && typeof pendingSell === "number") {
      pendingSellLineRef.current = cs.createPriceLine({
        price: pendingSell,
        color: THEME.red,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Pending sell",
      });
    }

    return () => {
      if (pendingBuyLineRef.current) {
        cs.removePriceLine(pendingBuyLineRef.current);
        pendingBuyLineRef.current = null;
      }
      if (pendingSellLineRef.current) {
        cs.removePriceLine(pendingSellLineRef.current);
        pendingSellLineRef.current = null;
      }
    };
  }, [pendingBuy, pendingSell, pivotHighPrice, pivotLowPrice]);

  // ── Pivot High / Pivot Low lines (current swing pivots) ───────────────────────
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    if (pivotHighLineRef.current) {
      cs.removePriceLine(pivotHighLineRef.current);
      pivotHighLineRef.current = null;
    }
    if (typeof pivotHighPrice === "number" && Number.isFinite(pivotHighPrice)) {
      pivotHighLineRef.current = cs.createPriceLine({
        price: pivotHighPrice,
        color: "#E9A23B",
        lineWidth: 0.5,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: ``,
      });
    }

    if (pivotLowLineRef.current) {
      cs.removePriceLine(pivotLowLineRef.current);
      pivotLowLineRef.current = null;
    }
    if (typeof pivotLowPrice === "number" && Number.isFinite(pivotLowPrice)) {
      pivotLowLineRef.current = cs.createPriceLine({
        price: pivotLowPrice,
        color: "#5FA8FF",
        lineWidth: 0.5,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "",
      });
    }

    return () => {
      if (pivotHighLineRef.current) {
        cs.removePriceLine(pivotHighLineRef.current);
        pivotHighLineRef.current = null;
      }
      if (pivotLowLineRef.current) {
        cs.removePriceLine(pivotLowLineRef.current);
        pivotLowLineRef.current = null;
      }
    };
  }, [pivotHighPrice, pivotLowPrice]);

  // ── Active StopLoss / TakeProfit lines for open trade ────────────────────────
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    if (slLineRef.current) {
      cs.removePriceLine(slLineRef.current);
      slLineRef.current = null;
    }
    if (typeof activeStopLoss === "number" && Number.isFinite(activeStopLoss)) {
      slLineRef.current = cs.createPriceLine({
        price: activeStopLoss,
        color: THEME.red,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Stop Loss",
      });
    }

    if (tpLineRef.current) {
      cs.removePriceLine(tpLineRef.current);
      tpLineRef.current = null;
    }
    if (typeof activeTakeProfit === "number" && Number.isFinite(activeTakeProfit)) {
      tpLineRef.current = cs.createPriceLine({
        price: activeTakeProfit,
        color: THEME.blue,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Take Profit",
      });
    }

    return () => {
      if (slLineRef.current) {
        cs.removePriceLine(slLineRef.current);
        slLineRef.current = null;
      }
      if (tpLineRef.current) {
        cs.removePriceLine(tpLineRef.current);
        tpLineRef.current = null;
      }
    };
  }, [activeStopLoss, activeTakeProfit]);

  // ── Vị trí pixel cho tam giác ngang (đỉnh chỉ vào giá entry) ─────────────────
  // Tọa độ từ chart là relative to pane; lấy pane offset từ DOM nếu có.
  useEffect(() => {
    if (trades.length === 0) {
      setEntryMarkerPositions([]);
      return;
    }
    const chart = chartRef.current;
    const cs = candleSeriesRef.current;
    if (!chart || !cs) return;

    const compute = () => {
      const ts = chart.timeScale();
      const positions = [];
      for (const trade of trades) {
        const t = Math.floor(trade.entryTimestamp / 1000);
        const x = ts.timeToCoordinate(t);
        const y = cs.priceToCoordinate(trade.entryPrice);
        if (x != null && y != null) positions.push({ x, y, type: trade.type });
      }
      setEntryMarkerPositions(positions);
    };

    compute();
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(compute);
    });
    return () => cancelAnimationFrame(id);
  }, [trades, overlayKey, candles.length]);

  // Recompute overlay positions when chart container resizes; track size for SVG viewBox
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      setOverlayKey((k) => k + 1);
      const { width, height } = el.getBoundingClientRect();
      setOverlaySize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, []);

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

  const candleByTime = useMemo(() => {
    const map = new Map();
    for (const c of candles) map.set(c.time, c);
    return map;
  }, [candles]);

  const hoveredCandle = hoveredTime != null ? candleByTime.get(hoveredTime) ?? null : null;
  const displayBar = hoveredCandle ?? liveCandle ?? (candles.length > 0 ? candles[candles.length - 1] : null);
  const barUp = displayBar ? displayBar.close >= displayBar.open : true;
  const barColor = barUp ? THEME.green : THEME.red;
  const rvolText =
    typeof currentRvol === "number" && Number.isFinite(currentRvol)
      ? ` · RVOL ${currentRvol.toFixed(2)}`
      : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: THEME.bgPrimary }}>
      {/* Header */}
      <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 16, borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0, userSelect: "none" }}>
        <select
          value={selectedProviderId}
          onChange={(e) => onProviderChange(e.target.value)}
          style={{ background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "3px 8px", fontSize: 12, cursor: "pointer" }}
        >
          {VISIBLE_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          value={selectedAsset}
          onChange={(e) => onAssetChange?.(e.target.value)}
          style={{ background: THEME.bgTertiary, color: THEME.textPrimary, border: `1px solid ${THEME.border}`, borderRadius: 4, padding: "3px 8px", fontSize: 12, cursor: "pointer" }}
        >
          {ASSET_OPTIONS.map((asset) => (
            <option key={asset} value={asset}>{asset}</option>
          ))}
        </select>
        <span style={{ color: THEME.textPrimary, fontWeight: 700, fontSize: 13 }}>{symbolLabel} · {INTERVALS.find((i) => i.value === selectedInterval)?.label ?? selectedInterval}{rvolText}</span>
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

      {/* Chart + overlay tam giác ngang tại giá entry */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10 }}>
          <svg width="100%" height="100%" viewBox={overlaySize.w && overlaySize.h ? `0 0 ${overlaySize.w} ${overlaySize.h}` : undefined} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
            {entryMarkerPositions.map((pos, i) => {
              const w = 10;
              const h = 4;
              const color = pos.type === "Long" ? THEME.blue : THEME.red;
              // Long: tam giác bên trái nến, đỉnh phải chỉ vào thân (tip at x,y)
              // Short: tam giác bên phải nến, đỉnh trái chỉ vào thân (tip at x,y)
              const points =
                pos.type === "Long"
                  ? `${pos.x - w},${pos.y - h} ${pos.x - w},${pos.y + h} ${pos.x},${pos.y}`
                  : `${pos.x + w},${pos.y - h} ${pos.x + w},${pos.y + h} ${pos.x},${pos.y}`;
              return <polygon key={i} points={points} fill={color} />;
            })}
          </svg>
        </div>
      </div>

      {/* Bottom bar: interval selector + zoom buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "6px 12px", borderTop: `1px solid ${THEME.bgSecondary}`, flexShrink: 0 }}>
        {INTERVALS.map((iv) => {
          const active = selectedInterval === iv.value;
          return (
            <button key={iv.value} onClick={() => onIntervalChange(iv.value)} style={{ padding: "3px 9px", fontSize: 12, fontFamily: "inherit", background: active ? THEME.blue : "transparent", color: active ? "#fff" : THEME.textSecondary, border: "none", borderRadius: 4, cursor: "pointer", fontWeight: active ? 600 : 400 }}>
              {iv.label}
            </button>
          );
        })}
        <div style={{ width: 1, height: 14, background: THEME.border, margin: "0 6px" }} />
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
function TradeTable({ trades, onTradeSelect, selectedTradeNumber }) {
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

            const selected = selectedTradeNumber === trade.tradeNumber;
            return (
              <>
                {/* Row 1: Exit */}
                <tr
                  key={`${trade.tradeNumber}-exit`}
                  onClick={() => onTradeSelect?.(trade)}
                  style={{ background: selected ? `${THEME.blue}22` : rowBgAlt, borderTop: `1px solid ${THEME.border}`, cursor: "pointer" }}
                >
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
                <tr
                  key={`${trade.tradeNumber}-entry`}
                  onClick={() => onTradeSelect?.(trade)}
                  style={{ background: selected ? `${THEME.blue}18` : rowBg, cursor: "pointer" }}
                >
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

function MinuteSimulationTable({ selectedTrade, rows, loading, error, sourceLabel, windowStartMs, windowEndMs, onClose }) {
  const panelStyle = {
    borderTop: `1px solid ${THEME.border}`,
    background: THEME.bgSecondary,
    padding: "8px 10px",
    maxHeight: 220,
    overflow: "auto",
  };

  if (!selectedTrade) {
    return <div style={{ ...panelStyle, color: THEME.textSecondary, fontSize: 12 }}>Click a trade to view minute-level open simulation.</div>;
  }
  if (loading) {
    return <div style={{ ...panelStyle, color: THEME.textSecondary, fontSize: 12 }}>Loading minute simulation...</div>;
  }
  if (error) {
    return <div style={{ ...panelStyle, color: THEME.red, fontSize: 12 }}>Simulation error: {error}</div>;
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: THEME.textPrimary, fontWeight: 600 }}>
          Trade #{selectedTrade.tradeNumber} ({selectedTrade.type}) minute replay
        </span>
        <span style={{ color: THEME.textSecondary, display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {formatDateTime(windowStartMs)} - {formatDateTime(windowEndMs)} · Source: {sourceLabel ?? "—"}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                padding: "2px 8px",
                fontSize: 12,
                background: THEME.bgTertiary,
                color: THEME.textSecondary,
                border: `1px solid ${THEME.border}`,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: 1.2,
              }}
              aria-label="Close minute simulation panel"
              title="Hide"
            >
              x
            </button>
          )}
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <thead>
          <tr>
            {["Time", "Current Price", "RVol", "Stop Sell At", "Stop Buy At"].map((h) => (
              <th key={h} style={{ textAlign: "left", fontSize: 11, padding: "5px 8px", color: THEME.textSecondary, borderBottom: `1px solid ${THEME.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: "8px", color: THEME.textSecondary, fontSize: 12 }}>
                No minute candles available in selected window.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.timeMs}>
              <td style={{ padding: "4px 8px", fontSize: 11, color: THEME.textPrimary }}>{formatDateTime(r.timeMs)}</td>
              <td style={{ padding: "4px 8px", fontSize: 11, color: THEME.textPrimary }}>{formatPrice(r.currentPrice)}</td>
              <td style={{ padding: "4px 8px", fontSize: 11, color: THEME.textPrimary }}>{r.rvol == null ? "—" : r.rvol.toFixed(2)}</td>
              <td style={{ padding: "4px 8px", fontSize: 11, color: THEME.red }}>{r.stopSellAt == null ? "—" : formatPrice(r.stopSellAt)}</td>
              <td style={{ padding: "4px 8px", fontSize: 11, color: THEME.green }}>{r.stopBuyAt == null ? "—" : formatPrice(r.stopBuyAt)}</td>
            </tr>
          ))}
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

function maxConsecutiveStreaks(closedTrades) {
  let maxWin = 0;
  let maxLoss = 0;
  let runWin = 0;
  let runLoss = 0;
  for (const t of closedTrades) {
    if (t.netPnL > 0) {
      runWin += 1;
      runLoss = 0;
      maxWin = Math.max(maxWin, runWin);
    } else if (t.netPnL < 0) {
      runLoss += 1;
      runWin = 0;
      maxLoss = Math.max(maxLoss, runLoss);
    } else {
      runWin = 0;
      runLoss = 0;
    }
  }
  return { maxWinStreak: maxWin, maxLossStreak: maxLoss };
}

// ─── Component: StrategyReport ────────────────────────────────────────────────
function StrategyReport({ trades, strategyName, onTradeSelect, selectedTradeNumber, detailPanel }) {
  const [activeTab, setActiveTab] = useState("trades");

  const winTrades = trades.filter((t) => !t.isOpen && t.netPnL > 0).length;
  const closedTrades = trades.filter((t) => !t.isOpen).length;
  const totalPnL = trades.reduce((sum, t) => (!t.isOpen ? sum + t.netPnL : sum), 0);

  const closed = trades.filter((t) => !t.isOpen);
  const { maxWinStreak, maxLossStreak } = maxConsecutiveStreaks(closed);
  const winners = closed.filter((t) => t.netPnL > 0);
  const losers = closed.filter((t) => t.netPnL < 0);
  const avgWinPct = winners.length > 0 ? winners.reduce((s, t) => s + (t.netPnLPercent ?? 0), 0) / winners.length : null;
  const avgLossPct = losers.length > 0 ? losers.reduce((s, t) => s + (t.netPnLPercent ?? 0), 0) / losers.length : null;
  const maxWinPct = winners.length > 0 ? Math.max(...winners.map((t) => t.netPnLPercent ?? 0)) : null;
  const maxLossPct = losers.length > 0 ? Math.min(...losers.map((t) => t.netPnLPercent ?? 0)) : null;

  const firstTs = trades.length > 0 ? trades[0].entryTimestamp : null;
  const startDateStr = firstTs
    ? new Date(firstTs).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : null;
  const totalDays = firstTs ? Math.floor((Date.now() - firstTs) / 86400000) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: THEME.bgPrimary, borderTop: `1px solid ${THEME.border}` }}>
      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", borderBottom: `1px solid ${THEME.bgSecondary}`, flexShrink: 0, flexWrap: "wrap" }}>
        <span style={{ color: THEME.textPrimary, fontWeight: 600, fontSize: 13 }}>{strategyName}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11, color: THEME.textSecondary, flexWrap: "wrap" }}>
          {startDateStr && <span>From: {startDateStr}</span>}
          {totalDays !== null && <span>{totalDays} days</span>}
          <span>{closedTrades} trades</span>
          <span>Win rate: {closedTrades ? Math.round((winTrades / closedTrades) * 100) : 0}%</span>
          <span style={{ color: totalPnL >= 0 ? THEME.green : THEME.red, fontWeight: 600 }}>
            Total P&L: {totalPnL >= 0 ? "+" : ""}{formatPrice(totalPnL)} USDT
          </span>
          <span>
            Max win streak: {closedTrades ? maxWinStreak : "—"} trades
          </span>
          <span>
            Max loss streak: {closedTrades ? maxLossStreak : "—"} trades
          </span>
          <span>Avg Win: {avgWinPct != null ? `${avgWinPct >= 0 ? "+" : ""}${avgWinPct.toFixed(2)}%` : "—"}</span>
          <span>Avg Loss: {avgLossPct != null ? `${avgLossPct.toFixed(2)}%` : "—"}</span>
          <span>Max Win: {maxWinPct != null ? `+${maxWinPct.toFixed(2)}%` : "—"}</span>
          <span>Max Loss: {maxLossPct != null ? `${maxLossPct.toFixed(2)}%` : "—"}</span>
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
        {activeTab === "trades" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <TradeTable trades={trades} onTradeSelect={onTradeSelect} selectedTradeNumber={selectedTradeNumber} />
            </div>
            {detailPanel}
          </div>
        )}
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

// ─── Trailing Stop Simulator (bar-by-bar, Bybit-standard) ────────────────────
// Bybit formula:
//   Long:  trailStopPrice = highestPrice × (1 - trailPct/100)
//   Short: trailStopPrice = lowestPrice  × (1 + trailPct/100)
// Activation: trail only arms after price moves minFePct% favorably from entry.
// Returns simulated exit P&L in USDT, or null if trail never triggered.
function simulateTrailingStop(trade, allCandles, trailPct, minFePct, feePctPerSide) {
  const { entryBarIndex, exitBarIndex, entryPrice, positionSize, positionValue } = trade;
  if (entryBarIndex == null || exitBarIndex == null) return null;

  const isLong          = trade.type === "Long";
  const trailMult       = trailPct / 100;
  // Activation price: price must reach this level before trail arms
  const activationPrice = isLong
    ? entryPrice * (1 + minFePct / 100)
    : entryPrice * (1 - minFePct / 100);

  let peakPrice   = entryPrice; // highest (long) or lowest (short) price seen
  let trailActive = false;

  for (let i = entryBarIndex; i < exitBarIndex; i++) {
    const bar = allCandles[i];
    if (!bar) break;

    // 1. Update peak price
    if (isLong) {
      peakPrice = Math.max(peakPrice, bar.high);
      if (!trailActive && peakPrice >= activationPrice) trailActive = true;
    } else {
      peakPrice = Math.min(peakPrice, bar.low);
      if (!trailActive && peakPrice <= activationPrice) trailActive = true;
    }

    // 2. Check if trail stop triggered (with gap protection)
    if (trailActive) {
      if (isLong) {
        const trailStopPrice = peakPrice * (1 - trailMult);
        if (bar.low <= trailStopPrice) {
          const exitPrice = Math.min(bar.open, trailStopPrice); // gap protection
          const gross = (exitPrice - entryPrice) * positionSize;
          const feeOpen  = positionValue * feePctPerSide;
          const feeClose = positionValue * feePctPerSide;
          return gross - feeOpen - feeClose;
        }
      } else {
        const trailStopPrice = peakPrice * (1 + trailMult);
        if (bar.high >= trailStopPrice) {
          const exitPrice = Math.max(bar.open, trailStopPrice); // gap protection
          const gross = (entryPrice - exitPrice) * positionSize;
          const feeOpen  = positionValue * feePctPerSide;
          const feeClose = positionValue * feePctPerSide;
          return gross - feeOpen - feeClose;
        }
      }
    }
  }

  return null; // trail never triggered — keep actual netPnL
}

// ─── Partial Take Profit (chốt lời) Simulator ─────────────────────────────────
// When unrealized profit >= thresholdPct%, close closeRatioPct% at threshold price,
// then run remainder with stop at entry (breakeven). Returns { netPnL } or null.
function simulatePartialTakeProfit(trade, allCandles, thresholdPct, closeRatioPct, feePctPerSide) {
  const { entryBarIndex, exitBarIndex, entryPrice, positionSize, type, exitPrice: originalExitPrice, positionValue } = trade;
  if (entryBarIndex == null || exitBarIndex == null || thresholdPct <= 0 || closeRatioPct <= 0 || closeRatioPct > 100) return null;

  const isLong = trade.type === "Long";
  const thresholdPrice = isLong
    ? entryPrice * (1 + thresholdPct / 100)
    : entryPrice * (1 - thresholdPct / 100);

  for (let i = entryBarIndex + 1; i <= exitBarIndex; i++) {
    const bar = allCandles[i];
    if (!bar) break;

    const profitPct = isLong
      ? ((bar.high - entryPrice) / entryPrice) * 100
      : ((entryPrice - bar.low) / entryPrice) * 100;

    if (profitPct < thresholdPct) continue;

    // First bar where threshold reached: partial close at threshold price
    const partialSize = positionSize * (closeRatioPct / 100);
    const remainderSize = positionSize * (1 - closeRatioPct / 100);
    const partialPnL = isLong
      ? (thresholdPrice - entryPrice) * partialSize
      : (entryPrice - thresholdPrice) * partialSize;

    // Remainder: same bar then i+1..exitBarIndex — breakeven at entry or original exit
    const hitEntry = (b) => (isLong ? b.low <= entryPrice : b.high >= entryPrice);
    let remainderExitPrice = null;

    if (hitEntry(bar)) {
      remainderExitPrice = entryPrice;
    } else {
      for (let j = i + 1; j <= exitBarIndex; j++) {
        const b = allCandles[j];
        if (!b) break;
        if (hitEntry(b)) {
          remainderExitPrice = entryPrice;
          break;
        }
      }
      if (remainderExitPrice === null) {
        const lastBar = allCandles[exitBarIndex];
        remainderExitPrice = originalExitPrice ?? lastBar?.close ?? entryPrice;
      }
    }

    const remainderPnL = isLong
      ? (remainderExitPrice - entryPrice) * remainderSize
      : (entryPrice - remainderExitPrice) * remainderSize;

    const gross = partialPnL + remainderPnL;
    const feeOpen  = positionValue * feePctPerSide;
    const feeClose = positionValue * feePctPerSide;
    return { netPnL: gross - feeOpen - feeClose };
  }

  return null; // threshold never reached — keep original trade
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [selectedProviderId, setSelectedProviderId] = useState(DEFAULT_PROVIDER_ID);
  const [selectedInterval, setSelectedInterval] = useState("30");
  const SYMBOL_STORAGE_KEY = "tvbt_symbol_v1";
  const [selectedAsset, setSelectedAsset] = useState(() => {
    try {
      const v = window?.localStorage?.getItem(SYMBOL_STORAGE_KEY);
      return ASSET_OPTIONS.includes(v) ? v : "BTC";
    } catch {
      return "BTC";
    }
  });
  const selectedSymbol = getProviderSymbol(selectedProviderId, selectedAsset);
  const symbolLabel = selectedSymbol ?? "—";

  const { candles, liveCandle, loading, error, refetch, fetchMore, hasMoreRef, loadingMoreRef } =
    useCandleData(selectedProviderId, selectedInterval, selectedSymbol);

  // ─── Persist strategy params per symbol ──────────────────────────────────
  const STRATEGY_PARAMS_STORAGE_KEY_PREFIX = "tvbt_strategy_params_v1";

  function makeStrategyParamsKey(providerId, asset, strategyId) {
    return `${STRATEGY_PARAMS_STORAGE_KEY_PREFIX}|${providerId}|${asset}|${strategyId}`;
  }

  function loadStrategyParams(providerId, asset, strategyId) {
    try {
      const raw = window?.localStorage?.getItem(makeStrategyParamsKey(providerId, asset, strategyId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveStrategyParams(providerId, asset, strategyId, params) {
    try {
      window?.localStorage?.setItem(
        makeStrategyParamsKey(providerId, asset, strategyId),
        JSON.stringify(params ?? {})
      );
    } catch {
      // ignore
    }
  }

  const handleAssetChange = (asset) => {
    const next = ASSET_OPTIONS.includes(asset) ? asset : "BTC";
    if (next === selectedAsset) return;
    setSelectedAsset(next);
    try {
      window?.localStorage?.setItem(SYMBOL_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    // Force refresh to avoid any stale WS/minute-detail state from previous symbol.
    window.location.reload();
  };

  // Strategy state
  const initialStrategyId = STRATEGIES[0].id;
  const [selectedStrategyId, setSelectedStrategyId] = useState(initialStrategyId);
  const [strategyParams, setStrategyParams] = useState(() => {
    const stored = loadStrategyParams(selectedProviderId, selectedAsset, initialStrategyId);
    return stored ?? getDefaultParams(STRATEGIES[0]);
  });
  const [positionSize, setPositionSize] = useState(5000);
  const [feePct, setFeePct]             = useState(0.05); // % per side (open and close)
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailPct, setTrailPct]         = useState(10);
  const [minFePct, setMinFePct]         = useState(1); // min FE% of position to activate trail
  const [partialThresholdPct, setPartialThresholdPct] = useState(0);
  const [partialCloseRatioPct, setPartialCloseRatioPct] = useState(50);
  const [prpEntryPriceMode, setPrpEntryPriceMode] = useState("Legacy");
  const [selectedTradeForDetail, setSelectedTradeForDetail] = useState(null);
  const [minuteDetailVisible, setMinuteDetailVisible] = useState(true);
  const [minuteDetailRows, setMinuteDetailRows] = useState([]);
  const [minuteDetailLoading, setMinuteDetailLoading] = useState(false);
  const [minuteDetailError, setMinuteDetailError] = useState(null);
  const [minuteDetailSource, setMinuteDetailSource] = useState(null);
  const [minuteDetailWindow, setMinuteDetailWindow] = useState({ startMs: null, endMs: null });
  const minuteDetailCacheRef = useRef(new Map());
  const minuteRangeCacheRef = useRef(new Map());
  const minuteDetailReqRef = useRef(0);
  const [repricedPrpSignals, setRepricedPrpSignals] = useState(null);
  const skipPersistRef = useRef(false);

  // Cập nhật params khi đổi strategy
  const handleStrategyChange = (id) => {
    // Avoid persisting the previous symbol's params during the first render after restore.
    skipPersistRef.current = true;
    setSelectedStrategyId(id);
    const stored = loadStrategyParams(selectedProviderId, selectedAsset, id);
    setStrategyParams(stored ?? getDefaultParams(STRATEGY_MAP[id]));
  };

  const handleParamChange = (key, val) => {
    setStrategyParams((prev) => ({ ...prev, [key]: val }));
  };

  // Restore params when switching provider/symbol; keep the currently selected strategy id.
  useEffect(() => {
    const strategy = STRATEGY_MAP[selectedStrategyId];
    if (!strategy) return;
    // Avoid persisting the previous symbol's params during the first render after restore.
    skipPersistRef.current = true;
    const stored = loadStrategyParams(selectedProviderId, selectedAsset, selectedStrategyId);
    setStrategyParams(stored ?? getDefaultParams(strategy));
  }, [selectedProviderId, selectedAsset]);

  // Persist params on every edit for this provider+symbol+strategy.
  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    saveStrategyParams(selectedProviderId, selectedAsset, selectedStrategyId, strategyParams);
  }, [selectedProviderId, selectedAsset, selectedStrategyId, strategyParams]);

  // liveCandle throttled 30s — tránh backtest recompute mỗi WS tick
  const liveCandleForBacktest = useThrottle(liveCandle, 30000);
  const allCandlesForBacktest = useMemo(
    () => (liveCandleForBacktest ? [...candles, liveCandleForBacktest] : candles),
    [candles, liveCandleForBacktest]
  );

  useEffect(() => {
    const strategy = STRATEGY_MAP[selectedStrategyId];
    if (!strategy || selectedStrategyId !== "prp-pivot-psar" || !allCandlesForBacktest.length) {
      setRepricedPrpSignals(null);
      return;
    }
    if (prpEntryPriceMode !== "Actual") {
      setRepricedPrpSignals(null);
      return;
    }
    if (strategyParams.filterMode !== "RVOL") {
      setRepricedPrpSignals(null);
      return;
    }

    const reqId = Date.now();
    let cancelled = false;
    const tfMs = intervalToMinutes(selectedInterval) * 60 * 1000;
    const lookback = Number(strategyParams.rvolLookback ?? 0);
    const minRvol = Number(strategyParams.rvolMin ?? 0);
    const baseSignals = strategy.generateSignals(allCandlesForBacktest, strategyParams);

    (async () => {
      const nextSignals = [...baseSignals];
      for (let idx = 0; idx < nextSignals.length; idx++) {
        const s = nextSignals[idx];
        const bar = allCandlesForBacktest[s.barIndex];
        if (!bar) continue;
        const startMs = bar.timestamp;
        const endMs = startMs + tfMs;
        const { candles: minuteCandles } = await loadMinuteRangeCached({
          providerId: selectedProviderId,
          symbol: selectedSymbol,
          startMs,
          endMs,
          inMemoryRef: minuteRangeCacheRef,
        });
        if (cancelled || reqId == null) return;
        if (!minuteCandles.length) continue;
        const tfCandles = allCandlesForBacktest.filter((c) => c.timestamp < startMs).sort((a, b) => a.time - b.time);
        const rvolArr = calcDynamicRvolForMinuteRows(minuteCandles, tfCandles, startMs, lookback);
        const tick = Number(strategyParams.minTick ?? 0.1);
        const triggerLevel = s.type === "long"
          ? (s.stopLevel ?? 0) + tick
          : (s.stopLevel ?? 0) - tick;
        let repriced = null;
        for (let i = 0; i < minuteCandles.length; i++) {
          const m = minuteCandles[i];
          const rvol = rvolArr[i];
          if (rvol == null || rvol < minRvol) continue;
          if (s.type === "long") {
            if (m.close >= triggerLevel) {
              repriced = m.close;
              break;
            }
          } else if (s.type === "short") {
            if (m.close <= triggerLevel) {
              repriced = m.close;
              break;
            }
          }
        }
        if (repriced != null && Number.isFinite(repriced)) {
          nextSignals[idx] = { ...s, entryPrice: repriced };
        }
      }
      if (!cancelled) setRepricedPrpSignals(nextSignals);
    })().catch(() => {
      if (!cancelled) setRepricedPrpSignals(null);
    });

    return () => {
      cancelled = true;
    };
  }, [
    selectedStrategyId,
    strategyParams,
    allCandlesForBacktest,
    selectedInterval,
    selectedProviderId,
    selectedSymbol,
    prpEntryPriceMode,
  ]);

  // Chạy backtest mỗi khi confirmed candles hoặc throttled live candle thay đổi
  const trades = useMemo(() => {
    const allCandles = allCandlesForBacktest;
    if (allCandles.length === 0) return [];
    const strategy = STRATEGY_MAP[selectedStrategyId];
    const sigs = selectedStrategyId === "prp-pivot-psar" && repricedPrpSignals?.length
      ? repricedPrpSignals
      : strategy.generateSignals(allCandles, strategyParams);
    return runBacktest(allCandles, sigs, { positionSizeUSDT: positionSize, feePct: feePct / 100 });
  }, [allCandlesForBacktest, selectedStrategyId, strategyParams, positionSize, feePct, repricedPrpSignals]);

  const partialEnabled = partialThresholdPct > 0 && partialCloseRatioPct > 0 && partialCloseRatioPct <= 100;

  const displayTrades = useMemo(() => {
    if (trades.length === 0) return trades;
    const allCandles = liveCandleForBacktest ? [...candles, liveCandleForBacktest] : candles;
    const initialCapital = trades[0].positionValue;

    if (partialEnabled) {
      let cumPnL = 0;
      return trades.map((t) => {
        const result = simulatePartialTakeProfit(t, allCandles, partialThresholdPct, partialCloseRatioPct, feePct / 100);
        const simPnL = result != null ? result.netPnL : t.netPnL;
        cumPnL += simPnL;
        return {
          ...t,
          netPnL:               simPnL,
          netPnLPercent:        (simPnL / t.positionValue) * 100,
          cumulativePnL:        cumPnL,
          cumulativePnLPercent: (cumPnL / initialCapital) * 100,
        };
      });
    }

    if (trailEnabled) {
      let cumPnL = 0;
      return trades.map((t) => {
        const trailPnL = simulateTrailingStop(t, allCandles, trailPct, minFePct, feePct / 100);
        const simPnL   = trailPnL !== null ? trailPnL : t.netPnL;
        cumPnL += simPnL;
        return {
          ...t,
          netPnL:               simPnL,
          netPnLPercent:        (simPnL / t.positionValue) * 100,
          cumulativePnL:        cumPnL,
          cumulativePnLPercent: (cumPnL / initialCapital) * 100,
        };
      });
    }

    return trades;
  }, [trades, partialEnabled, partialThresholdPct, partialCloseRatioPct, trailEnabled, trailPct, minFePct, candles, liveCandleForBacktest]);

  useEffect(() => {
    if (!selectedTradeForDetail) {
      setMinuteDetailRows([]);
      setMinuteDetailError(null);
      setMinuteDetailLoading(false);
      setMinuteDetailSource(null);
      return;
    }
    setMinuteDetailVisible(true);

    const strategy = STRATEGY_MAP[selectedStrategyId];
    const timeframeMin = intervalToMinutes(selectedInterval);
    const windowStartMs = selectedTradeForDetail.entryTimestamp;
    const windowEndMs = windowStartMs + timeframeMin * 60 * 1000;
    const tfMs = timeframeMin * 60 * 1000;
    setMinuteDetailWindow({ startMs: windowStartMs, endMs: windowEndMs });

    const cacheKey = [
      selectedProviderId,
      symbolLabel,
      selectedInterval,
      selectedStrategyId,
      selectedTradeForDetail.tradeNumber,
      selectedTradeForDetail.entryTimestamp,
      JSON.stringify(strategyParams),
    ].join("|");

    const cached = minuteDetailCacheRef.current.get(cacheKey);
    if (cached) {
      setMinuteDetailRows(cached.rows);
      setMinuteDetailSource(cached.source);
      setMinuteDetailError(null);
      setMinuteDetailLoading(false);
      return;
    }

    const reqId = ++minuteDetailReqRef.current;
    setMinuteDetailLoading(true);
    setMinuteDetailError(null);

    (async () => {
      let minuteCandlesAll = [];
      let source = selectedProviderId;

      const leftBars = Number(strategyParams.leftBars ?? 0);
      const rightBars = Number(strategyParams.rightBars ?? 0);
      const filterMode = strategyParams.filterMode ?? null;
      const useRvolFilter = filterMode === "RVOL";
      const useMfiFilter = filterMode === "MFI";
      const rvolLookback = Number(strategyParams.rvolLookback ?? 0);
      const mfiLength = Number(strategyParams.mfiLength ?? 0);

      const bufferTfBars = Math.max(
        leftBars + rightBars + 5,
        useRvolFilter ? rvolLookback + 5 : 0,
        useMfiFilter ? mfiLength + 5 : 0
      );

      // Keep total fetch <= 1000 minutes because current REST helpers don't paginate.
      const maxFetchMinutes = 1000;
      const maxStateStartMs = windowEndMs - maxFetchMinutes * 60 * 1000;
      const desiredStateStartMs = windowStartMs - bufferTfBars * tfMs;
      const stateStartMs = Math.max(desiredStateStartMs, maxStateStartMs);

      const loaded = await loadMinuteRangeCached({
        providerId: selectedProviderId,
        symbol: selectedSymbol,
        startMs: stateStartMs,
        endMs: windowEndMs,
        inMemoryRef: minuteRangeCacheRef,
      });
      minuteCandlesAll = loaded.candles;
      source = loaded.source;

      const minuteCandles = minuteCandlesAll.filter((c) => c.timestamp >= windowStartMs && c.timestamp < windowEndMs);
      if (minuteCandles.length === 0) {
        if (reqId !== minuteDetailReqRef.current) return;
        minuteDetailCacheRef.current.set(cacheKey, { rows: [], source });
        setMinuteDetailRows([]);
        setMinuteDetailSource(source);
        setMinuteDetailLoading(false);
        return;
      }

      const stateOffset = minuteCandlesAll.findIndex((c) => c.timestamp >= windowStartMs);
      const offset = stateOffset >= 0 ? stateOffset : 0;

      const aggregateMinutesToTimeframeCandles = (minutes) => {
        const map = new Map(); // bucketStartMs -> candle
        for (const m of minutes) {
          const bucketStart = Math.floor(m.timestamp / tfMs) * tfMs;
          if (!map.has(bucketStart)) {
            map.set(bucketStart, {
              timestamp: bucketStart,
              time: Math.floor(bucketStart / 1000),
              open: m.open,
              high: m.high,
              low: m.low,
              close: m.close,
              volume: m.volume ?? 0,
            });
          } else {
            const cur = map.get(bucketStart);
            cur.high = Math.max(cur.high, m.high);
            cur.low = Math.min(cur.low, m.low);
            cur.close = m.close;
            cur.volume += m.volume ?? 0;
          }
        }
        return [...map.values()].sort((a, b) => a.time - b.time);
      };

      const useRvol = Object.prototype.hasOwnProperty.call(strategyParams, "rvolLookback");
      const lookback = Number(strategyParams.rvolLookback ?? 0);
      const timeframeCandles = [...candles].sort((a, b) => a.time - b.time);
      const dynamicRvolArr = useRvol
        ? calcDynamicRvolForMinuteRows(minuteCandles, timeframeCandles, windowStartMs, lookback)
        : new Array(minuteCandles.length).fill(null);

      const rows = minuteCandles.map((c, i) => {
        const absIdx = offset + i;
        // Pending levels / pivots should be based on fully closed timeframe candles.
        // For a minute inside bucket [bucketStart, bucketStart+tfMs), the "current" candle
        // is still forming, so we exclude it by only using minutes < bucketStart.
        const bucketStartMs = Math.floor(c.timestamp / tfMs) * tfMs;
        const minutePrefixClosed = minuteCandlesAll
          .slice(0, absIdx + 1)
          .filter((m) => m.timestamp < bucketStartMs);
        const tfPrefixCandles = aggregateMinutesToTimeframeCandles(minutePrefixClosed);
        const pending = strategy?.getPendingLevels
          ? strategy.getPendingLevels(tfPrefixCandles, strategyParams)
          : { buy: null, sell: null };
        const rvol = dynamicRvolArr[i];
        return {
          timeMs: c.timestamp,
          currentPrice: c.close,
          rvol,
          stopSellAt: typeof pending.sell === "number" && Number.isFinite(pending.sell) ? pending.sell : null,
          stopBuyAt: typeof pending.buy === "number" && Number.isFinite(pending.buy) ? pending.buy : null,
        };
      });

      if (reqId !== minuteDetailReqRef.current) return;
      minuteDetailCacheRef.current.set(cacheKey, { rows, source });
      setMinuteDetailRows(rows);
      setMinuteDetailSource(source);
      setMinuteDetailLoading(false);
    })().catch((err) => {
      if (reqId !== minuteDetailReqRef.current) return;
      setMinuteDetailError(err?.message ?? "Failed to simulate minute details");
      setMinuteDetailRows([]);
      setMinuteDetailSource(null);
      setMinuteDetailLoading(false);
    });
  }, [selectedTradeForDetail, selectedProviderId, selectedSymbol, symbolLabel, selectedInterval, selectedStrategyId, strategyParams]);

  const pendingLevels = useMemo(() => {
    const s = STRATEGY_MAP[selectedStrategyId];
    if (!s.getPendingLevels || !candles.length) return { buy: null, sell: null };
    // PRP không show pending buy sell
    if (s.id === "prp-pivot-psar") {
      return { buy: null, sell: null };
    }
    // Các strategy khác vẫn dùng chỉ closed candles
    return s.getPendingLevels(candles, strategyParams);
  }, [selectedStrategyId, strategyParams, candles, liveCandleForBacktest]);
  const pivotLevels = useMemo(() => {
    const strategy = STRATEGY_MAP[selectedStrategyId];
    if (!strategy?.getCurrentPivots) {
      return { pivotHigh: null, pivotLow: null, pivotHighTime: null, pivotLowTime: null };
    }
    const candlesForPivots = strategy.id === "prp-pivot-psar" && liveCandleForBacktest
      ? [...candles, liveCandleForBacktest]
      : candles;
    if (!candlesForPivots.length) {
      return { pivotHigh: null, pivotLow: null, pivotHighTime: null, pivotLowTime: null };
    }
    const out = strategy.getCurrentPivots(candlesForPivots, strategyParams);
    return {
      pivotHigh: typeof out.pivotHigh === "number" && Number.isFinite(out.pivotHigh) ? out.pivotHigh : null,
      pivotLow:  typeof out.pivotLow === "number"  && Number.isFinite(out.pivotLow)  ? out.pivotLow : null,
      pivotHighTime: typeof out.pivotHighTime === "number" && Number.isFinite(out.pivotHighTime) ? out.pivotHighTime : null,
      pivotLowTime: typeof out.pivotLowTime === "number" && Number.isFinite(out.pivotLowTime) ? out.pivotLowTime : null,
    };
  }, [selectedStrategyId, strategyParams, candles, liveCandleForBacktest]);
  const activeExitLevels = useMemo(() => {
    const strategy = STRATEGY_MAP[selectedStrategyId];
    if (!strategy || !strategy.getActiveExitLevels) return { stopLoss: null, takeProfit: null };
    if (!candles.length || trades.length === 0) return { stopLoss: null, takeProfit: null };

    const openTrade = trades[trades.length - 1];
    if (!openTrade || !openTrade.isOpen) return { stopLoss: null, takeProfit: null };

    const allCandles = liveCandleForBacktest ? [...candles, liveCandleForBacktest] : candles;
    const levels = strategy.getActiveExitLevels(allCandles, strategyParams, openTrade);
    if (!levels) return { stopLoss: null, takeProfit: null };
    let { stopLoss, takeProfit } = levels;

    // For PRP strategy: if current StopLoss is beyond the opposite pending
    // stop entry level, it will never be hit (reversal happens first), so we
    // hide the SL line to avoid visual clutter.
    if (selectedStrategyId === "prp-pivot-psar") {
      const pendingBuy = pendingLevels.buy;
      const pendingSell = pendingLevels.sell;
      if (openTrade.type === "Long" && typeof stopLoss === "number" && typeof pendingSell === "number") {
        if (stopLoss < pendingSell) {
          stopLoss = null;
        }
      } else if (openTrade.type === "Short" && typeof stopLoss === "number" && typeof pendingBuy === "number") {
        if (stopLoss > pendingBuy) {
          stopLoss = null;
        }
      }
    }

    return {
      stopLoss: typeof stopLoss === "number" && Number.isFinite(stopLoss) ? stopLoss : null,
      takeProfit: typeof takeProfit === "number" && Number.isFinite(takeProfit) ? takeProfit : null,
    };
  }, [selectedStrategyId, strategyParams, candles, liveCandleForBacktest, trades, pendingLevels]);

  const currentRvol = useMemo(() => {
    const strategy = STRATEGY_MAP[selectedStrategyId];
    if (!strategy?.getCurrentRvol) return null;
    const candlesForRvol = strategy.id === "prp-pivot-psar" && liveCandleForBacktest
      ? [...candles, liveCandleForBacktest]
      : candles;
    return strategy.getCurrentRvol(candlesForRvol, strategyParams);
  }, [selectedStrategyId, strategyParams, candles, liveCandleForBacktest]);

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
        positionSize={positionSize}
        onPositionSizeChange={setPositionSize}
        feePct={feePct}
        onFeePctChange={setFeePct}
        partialThresholdPct={partialThresholdPct}
        onPartialThresholdPctChange={setPartialThresholdPct}
        partialCloseRatioPct={partialCloseRatioPct}
        onPartialCloseRatioPctChange={setPartialCloseRatioPct}
        trailEnabled={trailEnabled}
        onTrailEnabledChange={setTrailEnabled}
        trailPct={trailPct}
        onTrailPctChange={setTrailPct}
        minFePct={minFePct}
        onMinFePctChange={setMinFePct}
        prpEntryPriceMode={prpEntryPriceMode}
        onPrpEntryPriceModeChange={setPrpEntryPriceMode}
      />

      {/* Chart — 60% height */}
      <div style={{ flex: "0 0 60%", overflow: "hidden" }}>
        <CandlestickChart
          candles={candles}
          trades={trades}
          liveCandle={liveCandle}
          fetchMore={fetchMore}
          hasMoreRef={hasMoreRef}
          loadingMoreRef={loadingMoreRef}
          selectedInterval={selectedInterval}
          onIntervalChange={setSelectedInterval}
          selectedProviderId={selectedProviderId}
          onProviderChange={setSelectedProviderId}
          selectedAsset={selectedAsset}
          onAssetChange={handleAssetChange}
          symbolLabel={symbolLabel}
          pendingBuy={trades.length > 0 && trades[trades.length - 1].isOpen && trades[trades.length - 1].type === "Long" ? null : pendingLevels.buy}
          pendingSell={trades.length > 0 && trades[trades.length - 1].isOpen && trades[trades.length - 1].type === "Short" ? null : pendingLevels.sell}
          activeStopLoss={activeExitLevels.stopLoss}
          activeTakeProfit={activeExitLevels.takeProfit}
          pivotHighPrice={pivotLevels.pivotHigh}
          pivotLowPrice={pivotLevels.pivotLow}
          pivotHighTime={pivotLevels.pivotHighTime}
          pivotLowTime={pivotLevels.pivotLowTime}
          currentRvol={currentRvol}
        />
      </div>

      {/* Strategy report — 40% height */}
      <div style={{ flex: "0 0 40%", overflow: "hidden" }}>
        <StrategyReport
          trades={displayTrades}
          strategyName={strategy.name}
          onTradeSelect={setSelectedTradeForDetail}
          selectedTradeNumber={selectedTradeForDetail?.tradeNumber ?? null}
          detailPanel={
            minuteDetailVisible ? (
              <MinuteSimulationTable
                selectedTrade={selectedTradeForDetail}
                rows={minuteDetailRows}
                loading={minuteDetailLoading}
                error={minuteDetailError}
                sourceLabel={minuteDetailSource}
                windowStartMs={minuteDetailWindow.startMs}
                windowEndMs={minuteDetailWindow.endMs}
                onClose={() => setMinuteDetailVisible(false)}
              />
            ) : null
          }
        />
      </div>
    </div>
  );
}
