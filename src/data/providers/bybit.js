// Bybit provider: REST + WebSocket for linear perpetual (BTCUSDT)
// REST: result.list = [timestamp_ms, open, high, low, close, volume], newest first
// WS: kline.{interval}.{symbol}, msg.data[0] = { start, open, high, low, close, volume, confirm }

const BYBIT_REST = "https://api.bybit.com/v5/market/kline";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const PAGE_SIZE = 1000;

function normalizeBybitList(list) {
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

export const BybitProvider = {
  id: "bybit",
  name: "Bybit",

  getSymbol() {
    return "BTCUSDT";
  },

  mapInterval(interval) {
    return interval; // "5" | "15" | "30" | "60" | "D"
  },

  async fetchInitial(interval) {
    const symbol = this.getSymbol();
    const url = `${BYBIT_REST}?symbol=${symbol}&category=linear&interval=${interval}&limit=${PAGE_SIZE}`;
    const res = await window.fetch(url);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit API error");
    const list = data.result?.list ?? [];
    return { list: normalizeBybitList(list), hasMore: list.length >= PAGE_SIZE };
  },

  async fetchMore(interval, beforeTimestampMs) {
    const symbol = this.getSymbol();
    const url = `${BYBIT_REST}?symbol=${symbol}&category=linear&interval=${interval}&limit=${PAGE_SIZE}&end=${beforeTimestampMs - 1}`;
    const res = await window.fetch(url);
    const data = await res.json();
    if (data.retCode !== 0) return { list: [], hasMore: false };
    const list = data.result?.list ?? [];
    const normalized = normalizeBybitList(list);
    return { list: normalized, hasMore: list.length >= PAGE_SIZE };
  },

  wsUrl: BYBIT_WS,

  wsSupportsInterval(interval) {
    return true;
  },

  getWsSubscribePayload(interval) {
    const symbol = this.getSymbol();
    return [{ op: "subscribe", args: [`kline.${interval}.${symbol}`] }];
  },

  parseWsMessage(msg) {
    const data = typeof msg === "string" ? JSON.parse(msg) : msg;
    if (!data.topic?.startsWith("kline.") || !data.data?.length) return null;
    const d = data.data[0];
    const ts = parseInt(d.start);
    return {
      candle: {
        timestamp: ts,
        time: Math.floor(ts / 1000),
        open: parseFloat(d.open),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        close: parseFloat(d.close),
        volume: parseFloat(d.volume),
      },
      confirm: !!d.confirm,
    };
  },

  startWsPing(ws) {
    return setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
    }, 20000);
  },
};
