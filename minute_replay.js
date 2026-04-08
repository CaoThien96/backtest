#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { calcDynamicRvolForMinuteRows } from "./src/utils/rvolDynamicMinute.js";
import { buildFormingTfCandle, getBodyBias } from "./src/utils/formingTfBodyBias.js";
import { PrpPivotPsarStrategy } from "./src/strategies/prpPivotPsar.js";

function parseArgs(argv) {
  const out = {
    trades: "./trades_sol.json",
    params: "./sol_params.json",
    provider: "bybit",
    symbol: "SOLUSDT",
    tfMinutes: 30,
    breakout: "close",
    stopMode: "exact", // exact | proxy
    delayMsPerTrade: 1000,
    verbose: false,
    maxTrades: null,
    startTrade: null,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) continue;
    const [key, inlineVal] = a.slice(2).split("=", 2);
    const nextVal = inlineVal ?? args[i + 1];
    const hasInline = inlineVal != null;
    const bump = () => {
      if (!hasInline) i++;
    };

    switch (key) {
      case "trades":
        out.trades = nextVal;
        bump();
        break;
      case "params":
        out.params = nextVal;
        bump();
        break;
      case "provider":
        out.provider = nextVal;
        bump();
        break;
      case "symbol":
        out.symbol = nextVal;
        bump();
        break;
      case "tfMinutes":
        out.tfMinutes = Number(nextVal);
        bump();
        break;
      case "breakout":
        out.breakout = nextVal;
        bump();
        break;
      case "stopMode":
        out.stopMode = nextVal;
        bump();
        break;
      case "delayMsPerTrade":
        out.delayMsPerTrade = Number(nextVal);
        bump();
        break;
      case "verbose":
        out.verbose = nextVal === "true" || nextVal === "1";
        bump();
        break;
      case "maxTrades":
        out.maxTrades = nextVal != null ? Number(nextVal) : null;
        bump();
        break;
      case "startTrade":
        out.startTrade = nextVal != null ? Number(nextVal) : null;
        bump();
        break;
      default:
        // ignore unknown args
        break;
    }
  }
  return out;
}

function usage() {
  return `
minute_replay.js

Replays each PRP trade inside its TF bucket using 1m candles to find the first minute where:
  - dynamic RVOL >= rvolMin
  - optional direction confirm on the cumulative forming TF candle (params: directionConfirmMode / minBodyBias):
      None | Candle Color | Body Bias (same semantics as PRP on the intrabar-formed OHLC)

Then recomputes PnL with the new entry price (OHLC4 at breakout minute) and prints Old vs New metrics.

Usage:
  node ./minute_replay.js --trades ./trades.json --params ./prp_params.json

Options:
  --trades <path>             (default: ./trades.json)
  --params <path>             (default: ./prp_params.json)
  --provider bybit            (default: bybit)
  --symbol BTCUSDT            (default: BTCUSDT)
  --tfMinutes 30              (default: 30)
  --breakout close            (default: close)
  --stopMode exact|proxy      (default: exact)
      exact: rebuild signals to recover stopLevel, triggerLevel = stopLevel ± tick
      proxy: no rebuild, triggerLevel = oldEntryPrice
  --delayMsPerTrade 1000      (default: 1000)  wait between trades to avoid rate limits
  --maxTrades N               (default: unlimited)  process first N closed trades
  --startTrade N              (default: null)  start from tradeNumber >= N
  --verbose true|false        (default: false)
  -h, --help
`.trim();
}

function getDefaultParams(strategy) {
  const schema = strategy?.paramSchema ?? {};
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v?.default]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function normalizeBybitList(list) {
  // list: newest first, elements are arrays: [timestamp_ms, open, high, low, close, volume, ...]
  return [...list].reverse().map((c) => ({
    timestamp: parseInt(c[0], 10),
    time: Math.floor(parseInt(c[0], 10) / 1000),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5] ?? 0),
  }));
}

function isBybitRateLimit(data, statusCode) {
  const msg = String(data?.retMsg ?? "").toLowerCase();
  const code = Number(data?.retCode);
  if (statusCode === 429) return true;
  if (code === 10006 || code === 10018) return true;
  return msg.includes("too many visits") || msg.includes("rate limit");
}

async function fetchBybitKlinesOnce({ symbol, interval, startMs, endMs, limit = 1000 }) {
  const endInclusive = endMs - 1;
  const url = new URL("https://api.bybit.com/v5/market/kline");
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("limit", String(limit));
  if (startMs != null) url.searchParams.set("start", String(startMs));
  if (endMs != null) url.searchParams.set("end", String(endInclusive));

  const res = await fetch(url.toString());
  const data = await res.json();
  return { res, data };
}

async function fetchBybitKlines({ symbol, interval, startMs, endMs, limit = 1000 }) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { res, data } = await fetchBybitKlinesOnce({ symbol, interval, startMs, endMs, limit });
    if (data?.retCode === 0) {
      const list = data.result?.list ?? [];
      return normalizeBybitList(list);
    }
    const rateLimited = isBybitRateLimit(data, res?.status);
    if (!rateLimited || attempt === maxAttempts) {
      throw new Error(`Bybit API error: ${data?.retMsg || data?.retCode || res?.status}`);
    }
    const retryAfterSec = Number(res?.headers?.get?.("retry-after") ?? 0);
    const backoffMs = retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(20000, 1000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 300));
    console.warn(`Bybit rate limited (attempt ${attempt}/${maxAttempts}), retry in ${backoffMs}ms ...`);
    await sleep(backoffMs);
  }
  return [];
}

function sortAndDedupeByTime(candles) {
  const byTime = new Map();
  for (const c of candles) {
    if (c && typeof c.time === "number") byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function fetchBybitRangeChunked({ symbol, interval, startMs, endMs }) {
  // Backward pagination using `end=` because Bybit returns newest-first list.
  // We keep pulling older pages until we cover [startMs, endMs).
  const out = [];
  let cursorEnd = endMs;
  let safety = 0;
  while (cursorEnd > startMs && safety++ < 20000) {
    const page = await fetchBybitKlines({ symbol, interval, startMs: startMs, endMs: cursorEnd, limit: 1000 });
    if (!page.length) break;
    out.push(...page);
    const oldest = page[0]; // page is ascending after normalize
    const oldestTs = oldest?.timestamp ?? null;
    if (oldestTs == null) break;
    if (oldestTs <= startMs) break;
    cursorEnd = oldestTs;
    // polite pause between pages
    await sleep(150);
    if (page.length < 1000) break;
  }

  const merged = sortAndDedupeByTime(out).filter((c) => c.timestamp >= startMs && c.timestamp < endMs);
  return merged;
}

function tradeTypeToSide(t) {
  return t === "Long" ? "long" : "short";
}

function isWinPnL(netPnL) {
  // tie-rule: netPnL == 0 counts as loss
  return typeof netPnL === "number" && netPnL > 0;
}

function computeSummary(label, pnls) {
  const total = pnls.reduce((s, x) => s + x, 0);
  const wins = pnls.filter((x) => isWinPnL(x));
  const losses = pnls.filter((x) => !isWinPnL(x));
  const winrate = pnls.length ? (wins.length / pnls.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0;
  const maxWin = wins.length ? Math.max(...wins) : 0;
  const maxLoss = losses.length ? Math.min(...losses) : 0;

  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let curW = 0;
  let curL = 0;
  for (const x of pnls) {
    if (isWinPnL(x)) {
      curW++;
      curL = 0;
    } else {
      curL++;
      curW = 0;
    }
    maxWinStreak = Math.max(maxWinStreak, curW);
    maxLossStreak = Math.max(maxLossStreak, curL);
  }

  return {
    label,
    totalPnL: total,
    winratePct: winrate,
    maxWinStreak,
    maxLossStreak,
    avgWin,
    avgLoss,
    maxWin,
    maxLoss,
  };
}

function computeNetPnlFromTradeLike({ side, entryPrice, exitPrice, positionValue, feeOpen, feeClose }) {
  const positionSize = positionValue / entryPrice;
  const gross = side === "long"
    ? (exitPrice - entryPrice) * positionSize
    : (entryPrice - exitPrice) * positionSize;
  return gross - feeOpen - feeClose;
}

function classifyEntryQuality(side, oldEntry, newEntry, eps = 1e-9) {
  if (![oldEntry, newEntry].every((v) => typeof v === "number" && Number.isFinite(v))) return "equal";
  if (Math.abs(newEntry - oldEntry) <= eps) return "equal";
  if (side === "long") return newEntry < oldEntry ? "better" : "worse";
  return newEntry > oldEntry ? "better" : "worse";
}

function getEntryDistancePctText(side, oldEntry, newEntry) {
  if (![oldEntry, newEntry].every((v) => typeof v === "number" && Number.isFinite(v)) || oldEntry === 0) {
    return "—";
  }
  const rawPct = ((newEntry - oldEntry) / oldEntry) * 100;
  const beneficialPct = side === "long" ? -rawPct : rawPct;
  const sign = beneficialPct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(beneficialPct).toFixed(3)}%`;
}

function getOhlc4(candle) {
  if (!candle) return null;
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return (open + high + low + close) / 4;
}

/** Direction confirm on cumulative forming TF candle (open = first minute, high/low running, close = current minute). */
function passesFormingDirectionConfirm(type, formingCandle, mode, minBodyBias) {
  const m = mode ?? "None";
  if (m === "None") return true;
  if (!formingCandle) return false;
  const { open, close, high, low } = formingCandle;
  if (![open, close, high, low].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  if (m === "Candle Color") {
    return type === "long" ? close >= open : close <= open;
  }
  if (m === "Body Bias") {
    const threshold = Math.max(0, Math.min(1, Number(minBodyBias ?? 0)));
    return getBodyBias(type, formingCandle) >= threshold;
  }
  return true;
}

function looksLikeWrongSymbol(oldEntry, newEntry) {
  if (!Number.isFinite(oldEntry) || !Number.isFinite(newEntry) || oldEntry <= 0 || newEntry <= 0) return false;
  const ratio = newEntry / oldEntry;
  return ratio > 20 || ratio < 1 / 20;
}

function computeBucketDebugStats(minuteCandles, rvolArr) {
  let maxRvol = null;
  let nonNullRvol = 0;
  for (const r of rvolArr ?? []) {
    if (r == null || !Number.isFinite(r)) continue;
    nonNullRvol++;
    if (maxRvol == null || r > maxRvol) maxRvol = r;
  }
  let maxClose = null;
  let minClose = null;
  for (const c of minuteCandles ?? []) {
    const v = c?.close;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (maxClose == null || v > maxClose) maxClose = v;
    if (minClose == null || v < minClose) minClose = v;
  }
  return { maxRvolInBucket: maxRvol, nonNullRvolRows: nonNullRvol, maxClose, minClose };
}

async function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log(usage());
    process.exit(0);
  }

  if (opt.provider !== "bybit") {
    throw new Error(`Only provider=bybit is supported for this script right now (got ${opt.provider}).`);
  }
  if (opt.breakout !== "close") {
    throw new Error(`Only breakout=close is supported (got ${opt.breakout}).`);
  }
  if (opt.stopMode !== "exact" && opt.stopMode !== "proxy") {
    throw new Error(`Invalid stopMode=${opt.stopMode}. Use exact|proxy.`);
  }

  const tradesPath = path.resolve(opt.trades);
  const paramsPath = path.resolve(opt.params);

  const tradesRaw = await fs.readFile(tradesPath, "utf8");

  /** @type {Array<any>} */
  const tradesAll = JSON.parse(tradesRaw);
  /** @type {any} */
  let strategyParams = null;
  try {
    const paramsRaw = await fs.readFile(paramsPath, "utf8");
    strategyParams = JSON.parse(paramsRaw);
  } catch {
    strategyParams = getDefaultParams(PrpPivotPsarStrategy);
    console.warn(`WARN: params file not found/readable at ${paramsPath}. Using PRP defaults.`);
  }

  const closedTrades = (Array.isArray(tradesAll) ? tradesAll : [])
    .filter((t) => t && t.isOpen === false && typeof t.entryTimestamp === "number" && typeof t.entryPrice === "number")
    .filter((t) => (opt.startTrade != null ? (t.tradeNumber ?? 0) >= opt.startTrade : true))
    .sort((a, b) => (a.tradeNumber ?? 0) - (b.tradeNumber ?? 0));

  const trades = opt.maxTrades != null ? closedTrades.slice(0, opt.maxTrades) : closedTrades;
  if (!trades.length) {
    console.log("No closed trades to replay.");
    return;
  }

  const tfMs = opt.tfMinutes * 60 * 1000;
  const minEntryTs = Math.min(...trades.map((t) => t.entryTimestamp));
  const maxEntryTs = Math.max(...trades.map((t) => t.entryTimestamp));

  // Padding: pivots/daily levels need some history. 20 days is safe for most ranges.
  const padMs = 20 * 86400000;
  const tfStartMs = Math.max(0, minEntryTs - padMs);
  const tfEndMs = maxEntryTs + tfMs + 1;

  console.log(`Loading TF candles (interval=${opt.tfMinutes}m) from ${toIso(tfStartMs)} to ${toIso(tfEndMs)} ...`);
  const tfCandles = await fetchBybitRangeChunked({
    symbol: opt.symbol,
    interval: String(opt.tfMinutes),
    startMs: tfStartMs,
    endMs: tfEndMs,
  });
  console.log(`TF candles loaded: ${tfCandles.length}`);

  /** @type {Map<string, any>} */
  const signalMap = new Map();
  if (opt.stopMode === "exact") {
    console.log("Rebuilding signals to recover stopLevel (stopMode=exact) ...");
    const signals = PrpPivotPsarStrategy.generateSignals(tfCandles, strategyParams);
    for (const s of signals) {
      if (!s || typeof s.timestamp !== "number" || !s.type) continue;
      const key = `${s.timestamp}:${s.type}`;
      signalMap.set(key, s);
    }
    console.log(`Signals rebuilt: ${signals.length} (mapped: ${signalMap.size})`);
  } else {
    console.log("stopMode=proxy: skip rebuilding signals; will use oldEntryPrice as triggerLevel.");
  }

  const lookback = Number(strategyParams.rvolLookback ?? 0);
  const rvolMin = Number(strategyParams.rvolMin ?? 0);
  const tick = Number(strategyParams.minTick ?? 0);
  const directionConfirmMode = strategyParams.directionConfirmMode ?? "None";
  const minBodyBias = Number(strategyParams.minBodyBias ?? 0);

  console.log(
    `Replay gates: RVOL>=${rvolMin} (lookback=${lookback}) · directionConfirmMode=${directionConfirmMode}` +
    (directionConfirmMode === "Body Bias" ? ` (minBodyBias=${minBodyBias})` : "")
  );

  /** @type {Array<number>} */
  const oldPnls = [];
  /** @type {Array<number>} */
  const newPnls = [];
  let betterEntryCount = 0;
  let worseEntryCount = 0;
  let sameEntryCount = 0;

  for (let idx = 0; idx < trades.length; idx++) {
    const t = trades[idx];
    const side = tradeTypeToSide(t.type);
    const bucketStart = t.entryTimestamp;
    const bucketEnd = bucketStart + tfMs;

    let triggerLevel = null;
    let stopLevel = null;
    let usedStopMode = opt.stopMode;

    if (opt.stopMode === "exact") {
      const key = `${bucketStart}:${side}`;
      const sig = signalMap.get(key);
      stopLevel = sig?.stopLevel ?? null;
      if (typeof stopLevel === "number" && Number.isFinite(stopLevel)) {
        triggerLevel = side === "long" ? stopLevel + tick : stopLevel - tick;
      } else {
        // fallback
        usedStopMode = "proxy";
        triggerLevel = t.entryPrice;
      }
    } else {
      triggerLevel = t.entryPrice;
    }

    const startLabel = `${idx + 1}/${trades.length} #${t.tradeNumber} ${t.type}`;
    console.log(`\n${startLabel} bucket=${toIso(bucketStart)} trigger=${triggerLevel} stop=${stopLevel ?? "—"} mode=${usedStopMode}`);

    // Fetch 1m candles for this bucket
    const minuteCandles = await fetchBybitRangeChunked({
      symbol: opt.symbol,
      interval: "1",
      startMs: bucketStart,
      endMs: bucketEnd,
    });

    if (!minuteCandles.length) {
      console.log(`  No 1m candles fetched. Fallback newEntryPrice=oldEntryPrice (${t.entryPrice}).`);
      const newEntryPrice = t.entryPrice;
      const oldNet = Number(t.netPnL ?? 0);
      const newNet = computeNetPnlFromTradeLike({
        side,
        entryPrice: newEntryPrice,
        exitPrice: t.exitPrice,
        positionValue: t.positionValue,
        feeOpen: t.feeOpen,
        feeClose: t.feeClose,
      });
      oldPnls.push(oldNet);
      newPnls.push(newNet);
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    const tfCandlesForRvol = tfCandles.filter((c) => c.timestamp < bucketStart).sort((a, b) => a.time - b.time);
    const rvolArr = calcDynamicRvolForMinuteRows(minuteCandles, tfCandlesForRvol, bucketStart, lookback);

    // Step A: first minute where RVOL >= rvolMin AND forming-TF direction confirm (if enabled).
    let breakoutIdx = -1;
    let maxBodyBiasLong = 0;
    let maxBodyBiasShort = 0;
    for (let i = 0; i < minuteCandles.length; i++) {
      const m = minuteCandles[i];
      const rvol = rvolArr[i];
      const rvolOk = rvol != null && rvol >= rvolMin;
      const formingTf = buildFormingTfCandle(minuteCandles, 0, i);
      const bodyBiasLong = getBodyBias("long", formingTf);
      const bodyBiasShort = getBodyBias("short", formingTf);
      if (bodyBiasLong > maxBodyBiasLong) maxBodyBiasLong = bodyBiasLong;
      if (bodyBiasShort > maxBodyBiasShort) maxBodyBiasShort = bodyBiasShort;
      const dirOk = passesFormingDirectionConfirm(side, formingTf, directionConfirmMode, minBodyBias);
      if (opt.verbose) {
        console.log(
          `  scanBreakout ${toIso(m.timestamp)} close=${m.close} rvol=${rvol} rvolOk=${rvolOk} ` +
          `dirOk=${dirOk} mode=${directionConfirmMode} bodyBiasLong=${bodyBiasLong} bodyBiasShort=${bodyBiasShort}`
        );
      }
      if (rvolOk && dirOk) {
        breakoutIdx = i;
        break;
      }
    }

    if (breakoutIdx < 0) {
      const dbg = computeBucketDebugStats(minuteCandles, rvolArr);
      console.log(
        `  RVOL/direction breakout not found debug: triggerLevel=${triggerLevel} rvolMin=${rvolMin} lookback=${lookback} ` +
        `directionConfirmMode=${directionConfirmMode} minBodyBias=${minBodyBias} ` +
        `maxRvolInBucket=${dbg.maxRvolInBucket} nonNullRvolRows=${dbg.nonNullRvolRows} ` +
        `maxClose=${dbg.maxClose} minClose=${dbg.minClose} ` +
        `maxBodyBiasLong=${maxBodyBiasLong} maxBodyBiasShort=${maxBodyBiasShort}`
      );
    }

    // Step B: entry price is OHLC4 at breakout minute (fallback: close).
    let entryHit = null; // { entryPrice, timestamp, breakoutTimestamp, rvolAtBreakout, bodyBiasAtBreakout }
    if (breakoutIdx >= 0) {
      const breakoutTimestamp = minuteCandles[breakoutIdx].timestamp;
      const rvolAtBreakout = rvolArr[breakoutIdx];
      const formingAtBreakout = buildFormingTfCandle(minuteCandles, 0, breakoutIdx);
      const bodyBiasAtBreakout = formingAtBreakout ? getBodyBias(side, formingAtBreakout) : null;
      const breakoutOhlc4 = getOhlc4(minuteCandles[breakoutIdx]);
      const entryPrice = breakoutOhlc4 != null ? breakoutOhlc4 : minuteCandles[breakoutIdx].close;
      entryHit = {
        entryPrice,
        timestamp: breakoutTimestamp,
        breakoutTimestamp,
        rvolAtBreakout,
        bodyBiasAtBreakout,
      };
    }

    const newEntryPrice = entryHit?.entryPrice ?? t.entryPrice;
    if (entryHit && looksLikeWrongSymbol(t.entryPrice, entryHit.entryPrice)) {
      console.warn(
        `  WARN: newEntryPrice (${entryHit.entryPrice}) is far from oldEntryPrice (${t.entryPrice}). ` +
        `This usually means --symbol is wrong for this trades.json. Ignoring found minute and using oldEntryPrice.`
      );
      entryHit = null;
    }
    const safeNewEntryPrice = entryHit?.entryPrice ?? t.entryPrice;
    const oldNet = Number(t.netPnL ?? 0);
    const newNet = computeNetPnlFromTradeLike({
      side,
      entryPrice: safeNewEntryPrice,
      exitPrice: t.exitPrice,
      positionValue: t.positionValue,
      feeOpen: t.feeOpen,
      feeClose: t.feeClose,
    });

    oldPnls.push(oldNet);
    newPnls.push(newNet);
    const quality = classifyEntryQuality(side, t.entryPrice, safeNewEntryPrice);
    const entryDeltaPctText = getEntryDistancePctText(side, t.entryPrice, safeNewEntryPrice);
    if (quality === "better") betterEntryCount++;
    else if (quality === "worse") worseEntryCount++;
    else sameEntryCount++;

    console.log(
      `  Found=${entryHit ? toIso(entryHit.timestamp) : "—"} breakout=${entryHit ? toIso(entryHit.breakoutTimestamp) : "—"} ` +
      `rvolAtBreakout=${entryHit?.rvolAtBreakout ?? "—"} ` +
      `bodyBiasAtBreakout=${
        entryHit?.bodyBiasAtBreakout != null && Number.isFinite(entryHit.bodyBiasAtBreakout)
          ? entryHit.bodyBiasAtBreakout.toFixed(3)
          : "—"
      } ` +
      `oldEntry=${t.entryPrice} newEntry=${newEntryPrice} entryDelta=${entryDeltaPctText} ` +
      `oldPnL=${oldNet.toFixed(2)} newPnL=${newNet.toFixed(2)}`
    );

    await sleep(opt.delayMsPerTrade);
  }

  const oldSummary = computeSummary("Old", oldPnls);
  const newSummary = computeSummary("New", newPnls);

  console.log("\n=== Summary (Old vs New) ===");
  console.table([
    {
      Metric: "TotalPnL",
      Old: oldSummary.totalPnL,
      New: newSummary.totalPnL,
    },
    {
      Metric: "WinratePct",
      Old: oldSummary.winratePct,
      New: newSummary.winratePct,
    },
    {
      Metric: "MaxWinStreak",
      Old: oldSummary.maxWinStreak,
      New: newSummary.maxWinStreak,
    },
    {
      Metric: "MaxLossStreak",
      Old: oldSummary.maxLossStreak,
      New: newSummary.maxLossStreak,
    },
    {
      Metric: "AvgWin",
      Old: oldSummary.avgWin,
      New: newSummary.avgWin,
    },
    {
      Metric: "AvgLoss",
      Old: oldSummary.avgLoss,
      New: newSummary.avgLoss,
    },
    {
      Metric: "MaxWin",
      Old: oldSummary.maxWin,
      New: newSummary.maxWin,
    },
    {
      Metric: "MaxLoss",
      Old: oldSummary.maxLoss,
      New: newSummary.maxLoss,
    },
    {
      Metric: "EntryBetterCount",
      Old: 0,
      New: betterEntryCount,
    },
    {
      Metric: "EntryWorseCount",
      Old: 0,
      New: worseEntryCount,
    },
    {
      Metric: "EntrySameCount",
      Old: 0,
      New: sameEntryCount,
    },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

