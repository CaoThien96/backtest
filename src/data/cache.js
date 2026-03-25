// Persistent chart history cache (localStorage), keyed by provider + symbol + interval.
// Used to show history immediately on load and to avoid refetch when scrolling back.

const CACHE_KEY = "tvbt_cache_v1";
const MAX_CANDLES_PER_SERIES = 8000;

function getStorage() {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

/**
 * @typedef {{ time: number, timestamp?: number, open: number, high: number, low: number, close: number, volume?: number }} Candle
 * @typedef {{ from: number, to: number }} Range
 * @typedef {{ candles: Candle[], lastUpdated?: number, range?: Range }} SeriesEntry
 * @typedef {Record<string, Record<string, Record<string, SeriesEntry>>>} CacheState
 */

/**
 * @returns {CacheState}
 */
export function loadCache() {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {CacheState} state
 */
export function saveCache(state) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota or parse errors
  }
}

/**
 * @param {string} providerId
 * @param {string} interval
 * @returns {Candle[]}
 */
function resolveEntry(state, providerId, interval, symbol = "BTCUSDT") {
  const byProvider = state[providerId];
  if (!byProvider) return null;
  // New format: provider -> symbol -> interval
  if (byProvider[symbol]?.[interval]) return byProvider[symbol][interval];
  // Backward compatibility with old format: provider -> interval
  if (byProvider[interval]?.candles) return byProvider[interval];
  return null;
}

export function getCandlesFromCache(providerId, interval, symbol = "BTCUSDT") {
  const state = loadCache();
  const entry = resolveEntry(state, providerId, interval, symbol);
  if (!entry?.candles?.length) return [];
  return [...entry.candles].sort((a, b) => a.time - b.time);
}

/**
 * Merge new candles by timestamp (keep latest per bar), sort asc, cap size.
 * @param {string} providerId
 * @param {string} interval
 * @param {Candle[]} newCandles
 */
export function upsertCandlesInCache(providerId, interval, symbol = "BTCUSDT", newCandles) {
  if (!newCandles?.length) return;
  const state = loadCache();
  if (!state[providerId]) state[providerId] = {};
  if (!state[providerId][symbol]) state[providerId][symbol] = {};
  if (!state[providerId][symbol][interval]) state[providerId][symbol][interval] = { candles: [] };
  const entry = state[providerId][symbol][interval];
  const byTime = new Map(entry.candles.map((c) => [c.time, c]));
  for (const c of newCandles) {
    if (c != null && typeof c.time === "number") byTime.set(c.time, c);
  }
  let candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (candles.length > MAX_CANDLES_PER_SERIES) {
    candles = candles.slice(-MAX_CANDLES_PER_SERIES);
  }
  entry.candles = candles;
  entry.lastUpdated = Date.now();
  entry.range = candles.length
    ? { from: candles[0].time, to: candles[candles.length - 1].time }
    : undefined;
  saveCache(state);
}

/**
 * Get cached range for provider+interval. Used to decide if fetchMore can be served from cache.
 * @param {string} providerId
 * @param {string} interval
 * @returns {{ from: number, to: number } | null}
 */
export function getCachedRange(providerId, interval, symbol = "BTCUSDT") {
  const state = loadCache();
  const entry = resolveEntry(state, providerId, interval, symbol);
  return entry?.range ?? null;
}
