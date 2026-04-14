#!/usr/bin/env node
import process from "node:process";

import { PivotReversalStrategy } from "./src/strategies/pivotReversal.js";

const BYBIT_REST = "https://api.bybit.com/v5/market/kline";
const PAGE_SIZE = 1000;
const VALID_TIMEFRAMES = new Set(["5", "15", "30", "60", "D"]);

function parseArgs(argv) {
  const out = {
    provider: "bybit",
    symbol: "BTCUSDT",
    startTime: null,
    timeframe: null,
    leftBars: null,
    rightBars: null,
    minTick: null,
    help: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const [key, inlineVal] = arg.slice(2).split("=", 2);
    const hasInline = inlineVal != null;
    const nextVal = hasInline ? inlineVal : args[i + 1];
    const consume = () => {
      if (!hasInline) i += 1;
    };

    switch (key) {
      case "provider":
        out.provider = nextVal;
        consume();
        break;
      case "symbol":
        out.symbol = nextVal;
        consume();
        break;
      case "startTime":
        out.startTime = nextVal != null ? Number(nextVal) : null;
        consume();
        break;
      case "timeframe":
        out.timeframe = nextVal;
        consume();
        break;
      case "leftBars":
        out.leftBars = nextVal != null ? Number(nextVal) : null;
        consume();
        break;
      case "rightBars":
        out.rightBars = nextVal != null ? Number(nextVal) : null;
        consume();
        break;
      case "minTick":
        out.minTick = nextVal != null ? Number(nextVal) : null;
        consume();
        break;
      default:
        break;
    }
  }

  return out;
}

function usage() {
  return `
backtest_pivot_next_bar.js

Fetches Bybit candles from startTime to now for a timeframe, runs PivotReversal, and prints next-bar signal alignment stats.

Usage:
  node ./backtest_pivot_next_bar.js --startTime <ms> --timeframe <5|15|30|60|D> [options]

Required:
  --startTime <ms>               Start timestamp in milliseconds
  --timeframe <5|15|30|60|D>     Candle timeframe

Optional:
  --provider bybit               Default: bybit
  --symbol BTCUSDT               Default: BTCUSDT
  --leftBars <number>            Override strategy leftBars
  --rightBars <number>           Override strategy rightBars
  --minTick <number>             Override strategy minTick

Notes:
  - Alignment is measured on the candle immediately after each signal.
  - Signals on the final candle are skipped.
`.trim();
}

function getDefaultParams() {
  return Object.fromEntries(
    Object.entries(PivotReversalStrategy.paramSchema).map(([k, schema]) => [k, schema.default]),
  );
}

function normalizeBybitList(list) {
  return [...list].reverse().map((c) => {
    const ts = parseInt(c[0], 10);
    return {
      timestamp: ts,
      time: Math.floor(ts / 1000),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5] ?? 0),
    };
  });
}

async function fetchBybitKlines({ symbol, timeframe, startTime, endTime }) {
  const all = [];
  let cursorEnd = endTime;

  while (cursorEnd >= startTime) {
    const url =
      `${BYBIT_REST}?category=linear&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(timeframe)}&limit=${PAGE_SIZE}&start=${startTime}&end=${cursorEnd}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bybit API HTTP ${res.status}`);
    const data = await res.json();
    if (data?.retCode !== 0) throw new Error(data?.retMsg || "Bybit API error");

    const list = data?.result?.list ?? [];
    if (!Array.isArray(list) || list.length === 0) break;

    const normalized = normalizeBybitList(list);
    all.push(...normalized);

    const earliestTs = Math.min(...normalized.map((c) => c.timestamp));
    if (!Number.isFinite(earliestTs) || earliestTs <= startTime) break;
    cursorEnd = earliestTs - 1;
  }

  const dedupByTime = new Map();
  for (const c of all) dedupByTime.set(c.time, c);

  return [...dedupByTime.values()]
    .filter((c) => c.timestamp >= startTime && c.timestamp <= endTime)
    .sort((a, b) => a.time - b.time);
}

function computeNextBarAlignmentStats(signals, candles) {
  let longTotal = 0;
  let longAligned = 0;
  let shortTotal = 0;
  let shortAligned = 0;

  for (const sig of signals) {
    const nextBar = candles[sig.barIndex + 1];
    if (!nextBar) continue; // Skip last-candle signals with no next bar.

    if (sig.type === "long") {
      longTotal += 1;
      if (nextBar.close >= nextBar.open) longAligned += 1;
    } else if (sig.type === "short") {
      shortTotal += 1;
      if (nextBar.close <= nextBar.open) shortAligned += 1;
    }
  }

  const total = longTotal + shortTotal;
  const alignedTotal = longAligned + shortAligned;
  const alignedPct = total > 0 ? (alignedTotal / total) * 100 : 0;

  return {
    longTotal,
    longAligned,
    shortTotal,
    shortAligned,
    total,
    alignedTotal,
    alignedPct,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.provider !== "bybit") {
    throw new Error(`Unsupported provider "${args.provider}". This script currently supports only "bybit".`);
  }
  if (!Number.isFinite(args.startTime) || args.startTime <= 0) {
    throw new Error(`Invalid --startTime "${args.startTime}". Expected milliseconds timestamp.`);
  }
  if (!VALID_TIMEFRAMES.has(args.timeframe)) {
    throw new Error(`Invalid --timeframe "${args.timeframe}". Expected one of: 5, 15, 30, 60, D.`);
  }

  const now = Date.now();
  const candles = await fetchBybitKlines({
    symbol: args.symbol,
    timeframe: args.timeframe,
    startTime: args.startTime,
    endTime: now,
  });

  if (!candles.length) {
    console.log(
      JSON.stringify({
        longTotal: 0,
        longAligned: 0,
        shortTotal: 0,
        shortAligned: 0,
        total: 0,
        alignedTotal: 0,
        alignedPct: 0,
      }, null, 2),
    );
    return;
  }

  const params = getDefaultParams();
  if (Number.isFinite(args.leftBars)) params.leftBars = args.leftBars;
  if (Number.isFinite(args.rightBars)) params.rightBars = args.rightBars;
  if (Number.isFinite(args.minTick)) params.minTick = args.minTick;

  const signals = PivotReversalStrategy.generateSignals(candles, params);
  const stats = computeNextBarAlignmentStats(signals, candles);

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(`[backtest_pivot_next_bar] ${err?.message ?? err}`);
  process.exitCode = 1;
});
