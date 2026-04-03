#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { calcDynamicRvolForMinuteRows } from "./src/utils/rvolDynamicMinute.js";
import { PrpPivotPsarStrategy } from "./src/strategies/prpPivotPsar.js";

function parseArgs(argv) {
  const out = {
    trades: "./trades.json",
    params: "./prp_params.json",
    provider: "bybit",
    symbol: "BTCUSDT",
    tfMinutes: 30,
    stopMode: "exact", // exact | proxy
    delayMsPerTrade: 1000,
    verbose: false,
    maxTrades: null,
    startTrade: null,
    xPct: 0.2,
    maxWaitCandles: 5, // 0 => wait until next opposite trade signal
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
    const bump = () => { if (!hasInline) i++; };

    switch (key) {
      case "trades": out.trades = nextVal; bump(); break;
      case "params": out.params = nextVal; bump(); break;
      case "provider": out.provider = nextVal; bump(); break;
      case "symbol": out.symbol = nextVal; bump(); break;
      case "tfMinutes": out.tfMinutes = Number(nextVal); bump(); break;
      case "stopMode": out.stopMode = nextVal; bump(); break;
      case "delayMsPerTrade": out.delayMsPerTrade = Number(nextVal); bump(); break;
      case "verbose": out.verbose = nextVal === "true" || nextVal === "1"; bump(); break;
      case "maxTrades": out.maxTrades = nextVal != null ? Number(nextVal) : null; bump(); break;
      case "startTrade": out.startTrade = nextVal != null ? Number(nextVal) : null; bump(); break;
      case "xPct": out.xPct = Number(nextVal); bump(); break;
      case "maxWaitCandles": out.maxWaitCandles = Number(nextVal); bump(); break;
      default: break;
    }
  }
  return out;
}

function usage() {
  return `
minute_replay_limit.js

At RVOL breakout time (same detection as minute_replay.js), place a favorable LIMIT order:
  Long:  limit = triggerLevel * (1 - xPct/100)
  Short: limit = triggerLevel * (1 + xPct/100)

Then wait to fill:
  - If maxWaitCandles > 0: look at next N 1m candles (excluding breakout candle). If not filled => CANCEL.
  - If maxWaitCandles = 0: keep order alive until the next opposite trade signal timestamp (from trades.json), then CANCEL.

Fill rule:
  - Long fills if candle.low <= limitPrice (fill at limitPrice)
  - Short fills if candle.high >= limitPrice (fill at limitPrice)

Usage:
  node ./minute_replay_limit.js --symbol SOLUSDT --xPct 0.2 --maxWaitCandles 5 --stopMode exact

Options:
  --trades <path>             (default: ./trades.json)
  --params <path>             (default: ./prp_params.json)
  --provider bybit            (default: bybit)
  --symbol <symbol>           (default: BTCUSDT)
  --tfMinutes 30              (default: 30)
  --stopMode exact|proxy      (default: exact)
  --xPct <number>             (default: 0.2)
  --maxWaitCandles <int>      (default: 5)  0 => wait-until-opposite
  --delayMsPerTrade 1000      (default: 1000)
  --maxTrades N               (default: unlimited)
  --startTrade N              (default: null)
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
  try { return new Date(ms).toISOString(); } catch { return String(ms); }
}

function normalizeBybitList(list) {
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
  for (const c of candles) if (c && typeof c.time === "number") byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function fetchBybitRangeChunked({ symbol, interval, startMs, endMs }) {
  const out = [];
  let cursorEnd = endMs;
  let safety = 0;
  while (cursorEnd > startMs && safety++ < 20000) {
    const page = await fetchBybitKlines({ symbol, interval, startMs, endMs: cursorEnd, limit: 1000 });
    if (!page.length) break;
    out.push(...page);
    const oldest = page[0];
    const oldestTs = oldest?.timestamp ?? null;
    if (oldestTs == null) break;
    if (oldestTs <= startMs) break;
    cursorEnd = oldestTs;
    await sleep(150);
    if (page.length < 1000) break;
  }
  return sortAndDedupeByTime(out).filter((c) => c.timestamp >= startMs && c.timestamp < endMs);
}

function tradeTypeToSide(t) {
  return t === "Long" ? "long" : "short";
}

function isWinPnL(netPnL) {
  // tie => loss
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
    if (isWinPnL(x)) { curW++; curL = 0; } else { curL++; curW = 0; }
    maxWinStreak = Math.max(maxWinStreak, curW);
    maxLossStreak = Math.max(maxLossStreak, curL);
  }

  return { label, totalPnL: total, winratePct: winrate, maxWinStreak, maxLossStreak, avgWin, avgLoss, maxWin, maxLoss };
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

function buildFormingTfCandle(minuteCandles, startIdx, currIdx) {
  const first = minuteCandles?.[startIdx];
  if (!first) return null;
  let high = first.high;
  let low = first.low;
  for (let i = startIdx; i <= currIdx; i++) {
    const c = minuteCandles[i];
    if (!c) continue;
    if (typeof c.high === "number" && Number.isFinite(c.high)) high = Math.max(high, c.high);
    if (typeof c.low === "number" && Number.isFinite(c.low)) low = Math.min(low, c.low);
  }
  const close = minuteCandles?.[currIdx]?.close;
  return {
    open: first.open,
    high,
    low,
    close,
  };
}

function getBodyBias(side, formingCandle) {
  if (!formingCandle) return 0;
  const open = formingCandle.open;
  const close = formingCandle.close;
  const high = formingCandle.high;
  const low = formingCandle.low;
  if (![open, close, high, low].every((v) => typeof v === "number" && Number.isFinite(v))) return 0;
  const range = Math.max(high - low, 1e-9);
  if (side === "long") {
    const bullishBody = Math.max(close - open, 0);
    return bullishBody / range;
  }
  const bearishBody = Math.max(open - close, 0);
  return bearishBody / range;
}

function passesBodyBias(side, formingCandle, minBodyBias = 0.25) {
  return getBodyBias(side, formingCandle) >= minBodyBias;
}

function getNextOppositeTimestamp(tradesSorted, idx) {
  const cur = tradesSorted[idx];
  const curSide = tradeTypeToSide(cur.type);
  for (let j = idx + 1; j < tradesSorted.length; j++) {
    const t = tradesSorted[j];
    if (tradeTypeToSide(t.type) !== curSide) return t.entryTimestamp;
  }
  return null;
}

function calcLimitPrice(side, triggerLevel, xPct) {
  const x = xPct / 100;
  return side === "long" ? triggerLevel * (1 - x) : triggerLevel * (1 + x);
}

async function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log(usage());
    process.exit(0);
  }
  if (opt.provider !== "bybit") throw new Error(`Only provider=bybit supported (got ${opt.provider}).`);
  if (opt.stopMode !== "exact" && opt.stopMode !== "proxy") throw new Error(`Invalid stopMode=${opt.stopMode}. Use exact|proxy.`);
  if (!Number.isFinite(opt.xPct) || opt.xPct < 0) throw new Error(`Invalid xPct=${opt.xPct}. Must be >= 0.`);
  if (!Number.isFinite(opt.maxWaitCandles) || opt.maxWaitCandles < 0) throw new Error(`Invalid maxWaitCandles=${opt.maxWaitCandles}. Must be >= 0.`);

  const tradesPath = path.resolve(opt.trades);
  const paramsPath = path.resolve(opt.params);

  const tradesRaw = await fs.readFile(tradesPath, "utf8");
  const tradesAll = JSON.parse(tradesRaw);

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
  const padMs = 20 * 86400000;
  const tfStartMs = Math.max(0, minEntryTs - padMs);
  const tfEndMs = maxEntryTs + tfMs + 1;

  console.log(`Loading TF candles (interval=${opt.tfMinutes}m) from ${toIso(tfStartMs)} to ${toIso(tfEndMs)} ...`);
  const tfCandles = await fetchBybitRangeChunked({ symbol: opt.symbol, interval: String(opt.tfMinutes), startMs: tfStartMs, endMs: tfEndMs });
  console.log(`TF candles loaded: ${tfCandles.length}`);

  const signalMap = new Map();
  if (opt.stopMode === "exact") {
    console.log("Rebuilding signals to recover stopLevel (stopMode=exact) ...");
    const signals = PrpPivotPsarStrategy.generateSignals(tfCandles, strategyParams);
    for (const s of signals) {
      if (!s || typeof s.timestamp !== "number" || !s.type) continue;
      signalMap.set(`${s.timestamp}:${s.type}`, s);
    }
    console.log(`Signals rebuilt: ${signals.length} (mapped: ${signalMap.size})`);
  } else {
    console.log("stopMode=proxy: skip rebuilding signals; will use oldEntryPrice as triggerLevel.");
  }

  const lookback = Number(strategyParams.rvolLookback ?? 0);
  const rvolMin = Number(strategyParams.rvolMin ?? 0);
  const tick = Number(strategyParams.minTick ?? 0);
  const minBodyBias = 0.25;

  const oldPnlsAll = [];
  const newPnlsFilled = [];
  let cancelledCount = 0;
  let breakoutNotFoundCount = 0;
  let symbolMismatchGuardCount = 0;
  let betterEntryCount = 0;
  let worseEntryCount = 0;
  let sameEntryCount = 0;

  for (let idx = 0; idx < trades.length; idx++) {
    const t = trades[idx];
    const side = tradeTypeToSide(t.type);
    const bucketStart = t.entryTimestamp;
    const bucketEnd = bucketStart + tfMs;

    // Baseline old PnL
    const oldNet = Number(t.netPnL ?? 0);
    oldPnlsAll.push(oldNet);

    let triggerLevel = null;
    let stopLevel = null;
    let usedStopMode = opt.stopMode;

    if (opt.stopMode === "exact") {
      const sig = signalMap.get(`${bucketStart}:${side}`);
      stopLevel = sig?.stopLevel ?? null;
      if (typeof stopLevel === "number" && Number.isFinite(stopLevel)) {
        triggerLevel = side === "long" ? stopLevel + tick : stopLevel - tick;
      } else {
        usedStopMode = "proxy";
        triggerLevel = t.entryPrice;
      }
    } else {
      triggerLevel = t.entryPrice;
    }

    const startLabel = `${idx + 1}/${trades.length} #${t.tradeNumber} ${t.type}`;
    console.log(`\n${startLabel} bucket=${toIso(bucketStart)} trigger=${triggerLevel} stop=${stopLevel ?? "—"} mode=${usedStopMode}`);

    const minuteCandles = await fetchBybitRangeChunked({ symbol: opt.symbol, interval: "1", startMs: bucketStart, endMs: bucketEnd });
    if (!minuteCandles.length) {
      console.log("  No 1m candles fetched => CANCELLED");
      cancelledCount++;
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    // Compute dynamic RVOL like App
    const tfCandlesForRvol = tfCandles.filter((c) => c.timestamp < bucketStart).sort((a, b) => a.time - b.time);
    const rvolArr = calcDynamicRvolForMinuteRows(minuteCandles, tfCandlesForRvol, bucketStart, lookback);

    // 1) find breakout minute where BOTH RVOL and direction-confirm (Body Bias) pass.
    let breakoutIdx = -1;
    let rvolAtBreakout = null;
    let bodyBiasAtBreakout = null;
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
      const dirOk = passesBodyBias(side, formingTf, minBodyBias);
      if (opt.verbose) {
        console.log(
          `  scanBreakout ${toIso(m.timestamp)} close=${m.close} rvol=${rvol} rvolOk=${rvolOk} ` +
          `dirOk=${dirOk} bodyBiasLong=${bodyBiasLong} bodyBiasShort=${bodyBiasShort}`
        );
      }
      if (rvolOk && dirOk) {
        breakoutIdx = i;
        rvolAtBreakout = rvol;
        bodyBiasAtBreakout = side === "long" ? bodyBiasLong : bodyBiasShort;
        break;
      }
    }

    if (breakoutIdx < 0) {
      const dbg = computeBucketDebugStats(minuteCandles, rvolArr);
      console.log(
        `  Breakout minute not found => CANCELLED | ` +
        `triggerLevel=${triggerLevel} rvolMin=${rvolMin} lookback=${lookback} minBodyBias=${minBodyBias} ` +
        `maxRvolInBucket=${dbg.maxRvolInBucket} nonNullRvolRows=${dbg.nonNullRvolRows} ` +
        `maxClose=${dbg.maxClose} minClose=${dbg.minClose} ` +
        `maxBodyBiasLong=${maxBodyBiasLong} maxBodyBiasShort=${maxBodyBiasShort}`
      );
      breakoutNotFoundCount++;
      cancelledCount++;
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    const breakoutTime = minuteCandles[breakoutIdx].timestamp;
    const limitPrice = calcLimitPrice(side, triggerLevel, opt.xPct);

    // 2) wait fill after breakout candle (exclude breakout candle)
    const cancelAtTs = opt.maxWaitCandles === 0 ? getNextOppositeTimestamp(trades, idx) : null;
    let filledAt = null;

    if (opt.maxWaitCandles > 0) {
      const endIdxExclusive = Math.min(minuteCandles.length, breakoutIdx + 1 + opt.maxWaitCandles);
      for (let i = breakoutIdx + 1; i < endIdxExclusive; i++) {
        const c = minuteCandles[i];
        const ok = side === "long" ? c.low <= limitPrice : c.high >= limitPrice;
        if (opt.verbose) console.log(`  waitFill ${toIso(c.timestamp)} low=${c.low} high=${c.high} ok=${ok}`);
        if (ok) { filledAt = c.timestamp; break; }
      }
    } else {
      // wait until opposite trade timestamp (or end of available minutes in this bucket)
      // We only have minutes for the breakout bucket, so if cancelAtTs is outside the bucket,
      // this order might fill later — but by definition we cancel at the next opposite signal timestamp.
      // For this first version, we scan within this bucket only; if not filled, we cancel.
      const endTs = cancelAtTs != null ? Math.min(cancelAtTs, bucketEnd) : bucketEnd;
      for (let i = breakoutIdx + 1; i < minuteCandles.length; i++) {
        const c = minuteCandles[i];
        if (c.timestamp >= endTs) break;
        const ok = side === "long" ? c.low <= limitPrice : c.high >= limitPrice;
        if (opt.verbose) console.log(`  waitFillUntilOpp ${toIso(c.timestamp)} low=${c.low} high=${c.high} ok=${ok}`);
        if (ok) { filledAt = c.timestamp; break; }
      }
    }

    if (filledAt != null) {
      // Symbol sanity guard
      if (looksLikeWrongSymbol(t.entryPrice, limitPrice)) {
        symbolMismatchGuardCount++;
        console.warn(
          `  WARN: limitPrice (${limitPrice}) far from oldEntryPrice (${t.entryPrice}). ` +
          `Likely wrong --symbol for this trades.json. Treating as CANCELLED.`
        );
        cancelledCount++;
        await sleep(opt.delayMsPerTrade);
        continue;
      }

      const newNet = computeNetPnlFromTradeLike({
        side,
        entryPrice: limitPrice,
        exitPrice: t.exitPrice,
        positionValue: t.positionValue,
        feeOpen: t.feeOpen,
        feeClose: t.feeClose,
      });
      newPnlsFilled.push(newNet);
      const quality = classifyEntryQuality(side, t.entryPrice, limitPrice);
      if (quality === "better") betterEntryCount++;
      else if (quality === "worse") worseEntryCount++;
      else sameEntryCount++;
      console.log(
        `  Breakout=${toIso(breakoutTime)} rvolAtBreakout=${rvolAtBreakout} bodyBiasAtBreakout=${bodyBiasAtBreakout} ` +
        `limit=${limitPrice} FILLED=${toIso(filledAt)} ` +
        `oldPnL=${oldNet.toFixed(2)} newPnL=${newNet.toFixed(2)}`
      );
    } else {
      cancelledCount++;
      console.log(
        `  Breakout=${toIso(breakoutTime)} rvolAtBreakout=${rvolAtBreakout} bodyBiasAtBreakout=${bodyBiasAtBreakout} ` +
        `limit=${limitPrice} CANCELLED ` +
        (opt.maxWaitCandles > 0 ? `after ${opt.maxWaitCandles} candles` : `at oppositeTs=${cancelAtTs ? toIso(cancelAtTs) : "—"}`)
      );
    }

    await sleep(opt.delayMsPerTrade);
  }

  const oldSummary = computeSummary("OldAll", oldPnlsAll);
  const newSummary = computeSummary("NewFilledOnly", newPnlsFilled);
  const cancelRate = trades.length ? (cancelledCount / trades.length) * 100 : 0;

  console.log("\n=== Summary (Old vs New LIMIT) ===");
  console.table([
    { Metric: "TradesTotal", Old: trades.length, New: newPnlsFilled.length },
    { Metric: "CancelledCount", Old: 0, New: cancelledCount },
    { Metric: "CancelledRatePct", Old: 0, New: cancelRate },
    { Metric: "TotalPnL", Old: oldSummary.totalPnL, New: newSummary.totalPnL },
    { Metric: "WinratePct", Old: oldSummary.winratePct, New: newSummary.winratePct },
    { Metric: "MaxWinStreak", Old: oldSummary.maxWinStreak, New: newSummary.maxWinStreak },
    { Metric: "MaxLossStreak", Old: oldSummary.maxLossStreak, New: newSummary.maxLossStreak },
    { Metric: "AvgWin", Old: oldSummary.avgWin, New: newSummary.avgWin },
    { Metric: "AvgLoss", Old: oldSummary.avgLoss, New: newSummary.avgLoss },
    { Metric: "MaxWin", Old: oldSummary.maxWin, New: newSummary.maxWin },
    { Metric: "MaxLoss", Old: oldSummary.maxLoss, New: newSummary.maxLoss },
    { Metric: "EntryBetterCountFilled", Old: 0, New: betterEntryCount },
    { Metric: "EntryWorseCountFilled", Old: 0, New: worseEntryCount },
    { Metric: "EntrySameCountFilled", Old: 0, New: sameEntryCount },
    { Metric: "BreakoutNotFoundCount", Old: 0, New: breakoutNotFoundCount },
    { Metric: "SymbolMismatchGuardCount", Old: 0, New: symbolMismatchGuardCount },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

