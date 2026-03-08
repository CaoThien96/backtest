// Bitstamp provider: REST + WebSocket
// REST: GET ohlc/{currency_pair}/ step, limit, start, end (Unix sec). Response: data.ohlc = [ { timestamp, open, high, low, close, volume } ]
// WS: wss://ws.bitstamp.net, subscribe channel "ohlc_<timeframe>_btcusd"

const BITSTAMP_REST = "https://www.bitstamp.net/api/v2/ohlc";
const BITSTAMP_WS = "wss://ws.bitstamp.net";
const PAGE_SIZE = 1000;
const CURRENCY_PAIR = "btcusd";

// App interval "5"|"15"|"30"|"60"|"D" → Bitstamp step (seconds)
const INTERVAL_TO_STEP = {
  "5": 300,
  "15": 900,
  "30": 900,
  "60": 3600,
  D: 86400,
};

// App interval → WS channel timeframe suffix
const INTERVAL_TO_WS_TIMEFRAME = {
  "5": "5m",
  "15": "15m",
  "30": "30m",
  "60": "1h",
  D: "1d",
};

function normalizeBitstampList(ohlc) {
  // Bitstamp with start/end returns oldest first; keep ascending for chart (oldest first)
  const list = Array.isArray(ohlc) ? [...ohlc] : [];
  return list.map((c) => {
    const timeSec = parseInt(c.timestamp, 10);
    return {
      timestamp: timeSec * 1000,
      time: timeSec,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume ?? 0),
    };
  });
}

export const BitstampProvider = {
  id: "bitstamp",
  name: "Bitstamp",

  getSymbol() {
    return "BTC/USD";
  },

  mapInterval(interval) {
    return INTERVAL_TO_STEP[interval] ?? 900;
  },

  async fetchInitial(interval) {
    const step = this.mapInterval(interval);
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - PAGE_SIZE * step;
    const url = `${BITSTAMP_REST}/${CURRENCY_PAIR}/?step=${step}&limit=${PAGE_SIZE}&start=${startSec}&end=${endSec}`;
    const res = await window.fetch(url);
    if (!res.ok) throw new Error(`Bitstamp API: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const ohlc = data?.data?.ohlc ?? [];
    const list = normalizeBitstampList(ohlc);
    return { list, hasMore: ohlc.length >= PAGE_SIZE };
  },

  async fetchMore(interval, beforeTimestampMs) {
    const step = this.mapInterval(interval);
    const endSec = Math.floor((beforeTimestampMs - 1) / 1000);
    const startSec = endSec - PAGE_SIZE * step;
    const url = `${BITSTAMP_REST}/${CURRENCY_PAIR}/?step=${step}&limit=${PAGE_SIZE}&start=${startSec}&end=${endSec}`;
    const res = await window.fetch(url);
    if (!res.ok) return { list: [], hasMore: false };
    const data = await res.json();
    const ohlc = data?.data?.ohlc ?? [];
    if (ohlc.length === 0) return { list: [], hasMore: false };
    const list = normalizeBitstampList(ohlc);
    return { list, hasMore: ohlc.length >= PAGE_SIZE };
  },

  wsUrl: BITSTAMP_WS,

  wsSupportsInterval(interval) {
    return Object.hasOwn(INTERVAL_TO_WS_TIMEFRAME, interval);
  },

  getWsSubscribePayload(interval) {
    if (!this.wsSupportsInterval(interval)) return [];
    const timeframe = INTERVAL_TO_WS_TIMEFRAME[interval] ?? "15m";
    const channel = `ohlc_${timeframe}_${CURRENCY_PAIR}`;
    return [{ event: "bts:subscribe", data: { channel } }];
  },

  parseWsMessage(msg) {
    const data = typeof msg === "string" ? JSON.parse(msg) : msg;
    if (data?.event !== "data" || !data?.data) return null;
    const payload = data.data;
    if (payload?.channel && !payload.channel.startsWith("ohlc_")) return null;
    if (!payload?.timestamp) return null;
    const timeSec = parseInt(payload.timestamp, 10);
    return {
      candle: {
        timestamp: timeSec * 1000,
        time: timeSec,
        open: parseFloat(payload.open),
        high: parseFloat(payload.high),
        low: parseFloat(payload.low),
        close: parseFloat(payload.close),
        volume: parseFloat(payload.volume ?? 0),
      },
      confirm: false, // hook uses "new time" logic for bar close
    };
  },

  startWsPing() {
    return null;
  },
};
