// Coinbase provider: REST (Exchange API) + WebSocket (Advanced Trade)
// REST: GET /products/{product_id}/candles, [time_sec, low, high, open, close, volume], max 300
// WS: wss://advanced-trade-ws.coinbase.com, channel "candles" (5-minute buckets only)

const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://advanced-trade-ws.coinbase.com";
const PAGE_SIZE = 300;

// App interval "5"|"15"|"30"|"60"|"240"|"D" → Coinbase granularity (seconds). 4h not supported; use 21600 (6h).
const INTERVAL_TO_GRANULARITY = {
  "5": 300,
  "15": 900,
  "30": 900,
  "60": 3600,
  "240": 21600,
  D: 86400,
};

function normalizeCoinbaseList(list) {
  // Coinbase: [time_sec, low, high, open, close, volume]
  return [...list].reverse().map((c) => {
    const timeSec = parseInt(c[0]);
    return {
      timestamp: timeSec * 1000,
      time: timeSec,
      open: parseFloat(c[3]),
      high: parseFloat(c[2]),
      low: parseFloat(c[1]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5] ?? 0),
    };
  });
}

export const CoinbaseProvider = {
  id: "coinbase",
  name: "Coinbase",

  getSymbol() {
    return "BTC-USD";
  },

  mapInterval(interval) {
    return INTERVAL_TO_GRANULARITY[interval] ?? 900;
  },

  async fetchInitial(interval, productIdOverride) {
    const productId = productIdOverride ?? this.getSymbol();
    const granularity = this.mapInterval(interval);
    // Coinbase ignores range unless both start and end are set; request last PAGE_SIZE candles.
    const endMs = Date.now();
    const startMs = endMs - PAGE_SIZE * granularity * 1000;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const url = `${COINBASE_REST}/products/${productId}/candles?granularity=${granularity}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await window.fetch(url);
    if (!res.ok) throw new Error(`Coinbase API: ${res.status} ${res.statusText}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error("Coinbase API: invalid response");
    const normalized = normalizeCoinbaseList(list);
    return { list: normalized, hasMore: list.length >= PAGE_SIZE };
  },

  async fetchMore(interval, beforeTimestampMs, productIdOverride) {
    const productId = productIdOverride ?? this.getSymbol();
    const granularity = this.mapInterval(interval);
    // Coinbase ignores the range if either start or end is missing — must send both (ISO 8601).
    const endMs = beforeTimestampMs - 1;
    const startMs = endMs - PAGE_SIZE * granularity * 1000;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const url = `${COINBASE_REST}/products/${productId}/candles?granularity=${granularity}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await window.fetch(url);
    if (!res.ok) return { list: [], hasMore: false };
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return { list: [], hasMore: false };
    const normalized = normalizeCoinbaseList(list);
    return { list: normalized, hasMore: list.length >= PAGE_SIZE };
  },

  wsUrl: COINBASE_WS,

  wsSupportsInterval(interval) {
    return interval === "5"; // Coinbase WS only has 5-minute buckets
  },

  getWsSubscribePayload(interval, productIdOverride) {
    if (!this.wsSupportsInterval(interval)) return [];
    const productId = productIdOverride ?? this.getSymbol();
    return [
      { type: "subscribe", product_ids: [productId], channel: "candles" },
      { type: "subscribe", channel: "heartbeats" },
    ];
  },

  parseWsMessage(msg) {
    const data = typeof msg === "string" ? JSON.parse(msg) : msg;
    if (data.channel === "heartbeats") return null;
    if (data.channel !== "candles" || !data.events?.length) return null;
    const event = data.events[0];
    const candles = event?.candles;
    if (!candles?.length) return null;
    const c = candles[0];
    const start = c.start;
    const timeSec = typeof start === "string" ? parseInt(start, 10) : start;
    return {
      candle: {
        timestamp: timeSec * 1000,
        time: timeSec,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume ?? 0),
      },
      confirm: event.type === "snapshot" || !!c.end, // treat snapshot or closed bar as confirm
    };
  },

  startWsPing() {
    return null; // Coinbase uses heartbeats channel instead of client ping
  },
};
