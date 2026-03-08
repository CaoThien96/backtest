// Kraken provider: REST + WebSocket V2
// REST: GET /0/public/OHLC?pair=XBTUSD&interval=<min>&since= (optional). Result key e.g. XXBTZUSD, value: [ [time_sec, open, high, low, close, vwap, volume, count], ... ]
// Docs: "Returns up to 720 of the most recent entries (older data cannot be retrieved, regardless of the value of since)."
// WS V2: wss://ws.kraken.com/v2, subscribe ohlc channel; snapshot/update with interval_begin (RFC3339), open, high, low, close, volume
// Docs: https://docs.kraken.com/api/docs/websocket-v2/ohlc

const KRAKEN_REST = "https://api.kraken.com/0/public/OHLC";
const KRAKEN_WS = "wss://ws.kraken.com/v2";
const PAGE_SIZE = 720; // Kraken returns up to 720 of the most recent candles; no backward pagination

// App interval "5"|"15"|"30"|"60"|"D" → Kraken interval (minutes)
const INTERVAL_TO_MINUTES = {
  "5": 5,
  "15": 15,
  "30": 30,
  "60": 60,
  D: 1440,
};

function normalizeKrakenList(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // Kraken returns oldest first (asc by time); keep that order for chart
  return rows.map((c) => {
    const timeSec = parseInt(c[0], 10);
    return {
      timestamp: timeSec * 1000,
      time: timeSec,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6] ?? 0),
    };
  });
}

export const KrakenProvider = {
  id: "kraken",
  name: "Kraken",

  getSymbol() {
    return "BTC/USD";
  },

  mapInterval(interval) {
    return INTERVAL_TO_MINUTES[interval] ?? 15;
  },

  async fetchInitial(interval) {
    const minutes = this.mapInterval(interval);
    const url = `${KRAKEN_REST}?pair=XBTUSD&interval=${minutes}`;
    const res = await window.fetch(url);
    const data = await res.json();
    if (data.error && data.error.length) throw new Error(data.error.join(" ") || "Kraken API error");
    const result = data.result ?? {};
    const key = Object.keys(result)[0];
    const rows = key ? result[key] ?? [] : [];
    const list = normalizeKrakenList(rows);
    // Older data cannot be retrieved per Kraken docs — no "load more" when zooming out.
    return { list, hasMore: false };
  },

  async fetchMore() {
    // Kraken docs: "older data cannot be retrieved, regardless of the value of since". No API call.
    return { list: [], hasMore: false };
  },

  wsUrl: KRAKEN_WS,

  wsSupportsInterval(interval) {
    return Object.hasOwn(INTERVAL_TO_MINUTES, interval);
  },

  getWsSubscribePayload(interval) {
    if (!this.wsSupportsInterval(interval)) return [];
    const minutes = this.mapInterval(interval);
    return [
      {
        method: "subscribe",
        params: { channel: "ohlc", symbol: ["BTC/USD"], interval: minutes },
      },
    ];
  },

  parseWsMessage(msg) {
    const data = typeof msg === "string" ? JSON.parse(msg) : msg;
    if (data?.channel !== "ohlc" || !Array.isArray(data?.data) || data.data.length === 0) return null;
    const candleObj = data.data[0];
    const intervalBegin = candleObj?.interval_begin ?? candleObj?.timestamp;
    if (!intervalBegin) return null;
    const timeMs = new Date(intervalBegin).getTime();
    const timeSec = Math.floor(timeMs / 1000);
    return {
      candle: {
        timestamp: timeMs,
        time: timeSec,
        open: parseFloat(candleObj.open),
        high: parseFloat(candleObj.high),
        low: parseFloat(candleObj.low),
        close: parseFloat(candleObj.close),
        volume: parseFloat(candleObj.volume ?? 0),
      },
      confirm: data.type === "snapshot",
    };
  },

  startWsPing() {
    return null;
  },
};
