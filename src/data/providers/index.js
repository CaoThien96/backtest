// Data provider registry for chart candles (REST + WebSocket)

import { BybitProvider } from "./bybit.js";
import { CoinbaseProvider } from "./coinbase.js";
import { BitstampProvider } from "./bitstamp.js";
import { KrakenProvider } from "./kraken.js";

export const PROVIDERS = [BybitProvider, CoinbaseProvider, BitstampProvider, KrakenProvider];

export const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export const DEFAULT_PROVIDER_ID = "bybit";

export function getProvider(id) {
  const provider = PROVIDER_MAP[id ?? DEFAULT_PROVIDER_ID];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
