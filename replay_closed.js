#!/usr/bin/env node
/**
 * replay_closed.js — Re-evaluate closed trades using only the CLOSED TF bar at entryTimestamp.
 * No 1m data. Gates: TF RVOL (if filterMode=RVOL), direction confirm (PRP). Fill at bar.close when both pass.
 * Optional chase: if --maxWorseEntryChasePct > 0 and bar.close is worse than recorded entry beyond that %, place a limit at
 *   old entry (or oldEntry ± --chaseLimitRelaxedWorsePct when worse > --chaseLimitSteepPct) and wait for fill on later TF bars;
 *   cancel the limit when PRP emits an opposite signal on a bar. If maxWorseEntryChasePct is 0, chase filter is off (always fill at close when gates pass).
 *
 * Usage:
 *   node ./replay_closed.js --trades ./trades.json --params ./prp_params.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { PrpPivotPsarStrategy, computeRvol, passesDirectionConfirm } from "./src/strategies/prpPivotPsar.js";
import { getBodyBias } from "./src/utils/formingTfBodyBias.js";

function parseArgs(argv) {
  const out = {
    trades: "./trades_sol_1y.json",
    params: "./sol_params.json",
    provider: "bybit",
    symbol: "SOLUSDT",
    tfMinutes: 30,
    stopMode: "proxy",
    delayMsPerTrade: 0,
    verbose: false,
    maxTrades: null,
    startTrade: null,
    maxWorseEntryChasePct: 0,
    chaseLimitSteepPct: 0,
    chaseLimitRelaxedWorsePct: 0,
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
      case "maxWorseEntryChasePct":
        out.maxWorseEntryChasePct = Number(nextVal);
        bump();
        break;
      case "chaseLimitSteepPct":
        out.chaseLimitSteepPct = Number(nextVal);
        bump();
        break;
      case "chaseLimitRelaxedWorsePct":
        out.chaseLimitRelaxedWorsePct = Number(nextVal);
        bump();
        break;
      default:
        break;
    }
  }
  return out;
}

function usage() {
  return `
replay_closed.js

Re-evaluates each closed trade on the TF candle that starts at entryTimestamp (bar close only):
  - RVOL on TF series when params.filterMode === "RVOL" (same as PRP computeRvol); otherwise RVOL gate passes.
  - directionConfirmMode on that closed bar (passesDirectionConfirm from PRP).

When both gates pass: new entry = bar.close unless chase path applies (see below).

Chase (--maxWorseEntryChasePct): 0 = off (always fill at close). If > 0 and worse vs recorded entry exceeds it:
  LONG: limit buy at oldEntry, or at oldEntry*(1+chaseLimitRelaxedWorsePct/100) when worse% > chaseLimitSteepPct.
  SHORT: symmetric (limit at oldEntry or oldEntry*(1-chaseLimitRelaxedWorsePct/100)).
  chaseLimitRelaxedWorsePct is signed:
    LONG:  -1 => oldEntry*0.99, +1 => oldEntry*1.01
    SHORT: -1 => oldEntry*1.01, +1 => oldEntry*0.99
  Limit stays working until: price touches limit on a later bar (fill at limit), or PRP opposite signal on a bar (cancel), or data ends (cancel).

Trigger/stop in logs follows stopMode exact|proxy like minute_replay.js (informational only).

Usage:
  node ./replay_closed.js --trades ./trades.json --params ./prp_params.json

Options:
  --trades <path>             (default: ./trades.json)
  --params <path>             (default: ./prp_params.json)
  --provider bybit            (default: bybit)
  --symbol SOLUSDT            (default: SOLUSDT)
  --tfMinutes 30              (default: 30)
  --stopMode exact|proxy      (default: exact)
  --maxWorseEntryChasePct N       (default: 3)  worse vs recorded entry; 0 = off (no limit/cancel)
  --chaseLimitSteepPct N          (default: 3)  if worse% > this, use relaxed limit price (below)
  --chaseLimitRelaxedWorsePct N   (default: -0.2) signed; LONG: oldEntry*(1+N/100), SHORT: oldEntry*(1-N/100)
  --delayMsPerTrade 1000      (default: 1000)
  --maxTrades N
  --startTrade N
  --verbose true|false
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

function computeReplayedExitPrice(trade, replayedEntryPrice, nextTrade, nextTradeReplayedEntryPrice) {
  const oldEntry = Number(trade?.entryPrice);
  const oldExit = Number(trade?.exitPrice);
  if (!Number.isFinite(oldEntry) || oldEntry <= 0 || !Number.isFinite(oldExit)) return oldExit;
  if (!Number.isFinite(replayedEntryPrice) || replayedEntryPrice <= 0) return oldExit;
  const exitSignal = String(trade?.exitSignal ?? "").trim().toLowerCase();

  if (exitSignal === "take profit" || exitSignal === "stop loss") {
    // Keep the same % distance from entry for TP/SL exits.
    return replayedEntryPrice * (oldExit / oldEntry);
  }
  if (exitSignal === "le" || exitSignal === "se") {
    const nextEntry = Number.isFinite(nextTradeReplayedEntryPrice)
      ? Number(nextTradeReplayedEntryPrice)
      : Number(nextTrade?.entryPrice);
    return Number.isFinite(nextEntry) ? nextEntry : oldExit;
  }
  return oldExit;
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

function looksLikeWrongSymbol(oldEntry, newEntry) {
  if (!Number.isFinite(oldEntry) || !Number.isFinite(newEntry) || oldEntry <= 0 || newEntry <= 0) return false;
  const ratio = newEntry / oldEntry;
  return ratio > 20 || ratio < 1 / 20;
}

/** LONG: worse if newEntry > oldEntry. SHORT: worse if newEntry < oldEntry. maxPct <= 0 disables check. */
function exceedsMaxWorseEntryChasePct(side, oldEntry, newEntry, maxPct) {
  if (!Number.isFinite(maxPct) || maxPct <= 0) return false;
  if (!Number.isFinite(oldEntry) || !Number.isFinite(newEntry) || oldEntry <= 0) return false;
  if (side === "long") {
    if (newEntry <= oldEntry) return false;
    return ((newEntry - oldEntry) / oldEntry) * 100 > maxPct;
  }
  if (newEntry >= oldEntry) return false;
  return ((oldEntry - newEntry) / oldEntry) * 100 > maxPct;
}

function worseEntryChasePct(side, oldEntry, newEntry) {
  if (!Number.isFinite(oldEntry) || !Number.isFinite(newEntry) || oldEntry <= 0) return 0;
  if (side === "long") {
    if (newEntry <= oldEntry) return 0;
    return ((newEntry - oldEntry) / oldEntry) * 100;
  }
  if (newEntry >= oldEntry) return 0;
  return ((oldEntry - newEntry) / oldEntry) * 100;
}

/**
 * LONG: limit at oldEntry, or oldEntry*(1+relaxed/100) if worsePct > steepPct.
 * SHORT: limit at oldEntry, or oldEntry*(1-relaxed/100) if worsePct > steepPct.
 * relaxed can be negative (signed behavior).
 */
function computeChaseLimitPrice(side, oldEntry, worsePct, steepPct, relaxedWorsePct) {
  if (!Number.isFinite(oldEntry) || oldEntry <= 0) return null;
  const steep = Number.isFinite(steepPct) ? steepPct : 3;
  const rel = Number.isFinite(relaxedWorsePct) ? relaxedWorsePct : 1;
  if (side === "long") {
    if (worsePct > steep) return oldEntry * (1 + rel / 100);
    return oldEntry;
  }
  if (worsePct > steep) return oldEntry * (1 - rel / 100);
  return oldEntry;
}

/**
 * After entry bar closes: walk forward TF bars. Long buy limit fills if low <= limit; short sell limit if high >= limit.
 * Opposite PRP signal on a bar cancels the limit (no fill on that bar unless limit touched first).
 */
function scanChaseLimitPath({ side, limitPrice, entryBarIdx, tfSorted, signalsByTs }) {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    return { ok: false, reason: "chase_limit_eod", barsWaited: 0 };
  }
  for (let j = entryBarIdx + 1; j < tfSorted.length; j++) {
    const b = tfSorted[j];
    const sig = signalsByTs.get(b.timestamp);

    if (side === "long") {
      if (Number.isFinite(b.low) && b.low <= limitPrice) {
        return { ok: true, fillPrice: limitPrice, barsWaited: j - entryBarIdx };
      }
      if (sig?.short) {
        return { ok: false, reason: "chase_limit_opposite", barsWaited: j - entryBarIdx };
      }
    } else {
      if (Number.isFinite(b.high) && b.high >= limitPrice) {
        return { ok: true, fillPrice: limitPrice, barsWaited: j - entryBarIdx };
      }
      if (sig?.long) {
        return { ok: false, reason: "chase_limit_opposite", barsWaited: j - entryBarIdx };
      }
    }
  }
  return { ok: false, reason: "chase_limit_eod", barsWaited: Math.max(0, tfSorted.length - 1 - entryBarIdx) };
}

function printSummaryBlock({
  oldPnls,
  newPnlsFilled,
  totalTrades,
  cancelledCount,
  cancelReasons,
  limitFilledCount,
  cancelledOldPnlNet,
  cancelledOldPnlPositive,
  cancelledOldPnlNegative,
  betterEntryCount,
  worseEntryCount,
  sameEntryCount,
}) {
  const oldSummary = computeSummary("Old", oldPnls);
  const newSummary = computeSummary("New (filled)", newPnlsFilled);
  const cancelRate = totalTrades ? (cancelledCount / totalTrades) * 100 : 0;

  console.log("\n=== Summary (Old vs New) ===");
  console.table([
    { Metric: "TotalTrades", Old: totalTrades, New: totalTrades },
    { Metric: "FilledCount", Old: "—", New: newPnlsFilled.length },
    { Metric: "LimitFilledCount", Old: 0, New: limitFilledCount },
    { Metric: "CancelledCount", Old: 0, New: cancelledCount },
    { Metric: "CancelRatePct", Old: 0, New: Number(cancelRate.toFixed(2)) },
    { Metric: "CancelledOldPnlNet", Old: 0, New: cancelledOldPnlNet },
    { Metric: "CancelledOldPnlPositive", Old: 0, New: cancelledOldPnlPositive },
    { Metric: "CancelledOldPnlNegative", Old: 0, New: cancelledOldPnlNegative },
    { Metric: "Cancel_missing_bar", Old: 0, New: cancelReasons.missing_bar ?? 0 },
    { Metric: "Cancel_rvol", Old: 0, New: cancelReasons.rvol ?? 0 },
    { Metric: "Cancel_direction", Old: 0, New: cancelReasons.direction ?? 0 },
    { Metric: "Cancel_chase_limit_opposite", Old: 0, New: cancelReasons.chase_limit_opposite ?? 0 },
    { Metric: "Cancel_chase_limit_eod", Old: 0, New: cancelReasons.chase_limit_eod ?? 0 },
    { Metric: "Cancel_wrong_symbol", Old: 0, New: cancelReasons.wrong_symbol ?? 0 },
    { Metric: "TotalPnL", Old: oldSummary.totalPnL, New: newSummary.totalPnL },
    { Metric: "WinratePct", Old: oldSummary.winratePct, New: newSummary.winratePct },
    { Metric: "MaxWinStreak", Old: oldSummary.maxWinStreak, New: newSummary.maxWinStreak },
    { Metric: "MaxLossStreak", Old: oldSummary.maxLossStreak, New: newSummary.maxLossStreak },
    { Metric: "AvgWin", Old: oldSummary.avgWin, New: newSummary.avgWin },
    { Metric: "AvgLoss", Old: oldSummary.avgLoss, New: newSummary.avgLoss },
    { Metric: "MaxWin", Old: oldSummary.maxWin, New: newSummary.maxWin },
    { Metric: "MaxLoss", Old: oldSummary.maxLoss, New: newSummary.maxLoss },
    { Metric: "EntryBetterCount", Old: 0, New: betterEntryCount },
    { Metric: "EntryWorseCount", Old: 0, New: worseEntryCount },
    { Metric: "EntrySameCount", Old: 0, New: sameEntryCount },
  ]);
}

async function runReplayClosed(opt, {
  trades,
  tfSorted,
  signalMap,
  strategyParams,
  signalsByTs,
}) {
  const lookback = Number(strategyParams.rvolLookback ?? 0);
  const rvolMin = Number(strategyParams.rvolMin ?? 0);
  const tick = Number(strategyParams.minTick ?? 0);
  const filterMode = strategyParams.filterMode ?? "None";
  const directionConfirmMode = strategyParams.directionConfirmMode ?? "None";
  const minBodyBias = Math.max(0, Math.min(1, Number(strategyParams.minBodyBias ?? 0)));
  const maxWorseEntryChasePct = Number(opt.maxWorseEntryChasePct);
  const chaseLimitSteepPct = Number(opt.chaseLimitSteepPct);
  const chaseLimitRelaxedWorsePct = Number(opt.chaseLimitRelaxedWorsePct);

  const rvolArr = computeRvol(tfSorted, lookback);

  const oldPnls = [];
  const newPnlsFilled = [];
  const replayRows = [];
  const replayedEntryByIdx = new Map();
  let betterEntryCount = 0;
  let worseEntryCount = 0;
  let sameEntryCount = 0;
  let limitFilledCount = 0;
  let cancelledOldPnlNet = 0;
  let cancelledOldPnlPositive = 0;
  let cancelledOldPnlNegative = 0;
  const cancelReasons = {
    missing_bar: 0,
    rvol: 0,
    direction: 0,
    chase_limit_opposite: 0,
    chase_limit_eod: 0,
    wrong_symbol: 0,
  };
  let cancelledCount = 0;

  for (let idx = 0; idx < trades.length; idx++) {
    if(idx === 595){
      console.log()
    }
    const t = trades[idx];
    const side = tradeTypeToSide(t.type);
    const bucketStart = t.entryTimestamp;

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
        usedStopMode = "proxy";
        triggerLevel = t.entryPrice;
      }
    } else {
      triggerLevel = t.entryPrice;
    }

    const barIdx = tfSorted.findIndex((c) => c.timestamp === bucketStart);
    const bar = barIdx >= 0 ? tfSorted[barIdx] : null;

    const startLabel = `${idx + 1}/${trades.length} #${t.tradeNumber} ${t.type}`;
    const trigLog = Number.isFinite(triggerLevel) && triggerLevel !== 0 ? triggerLevel : "—";

    const bumpCancel = (reason) => {
      cancelledCount++;
      cancelledOldPnlNet += oldNet;
      if (oldNet > 0) cancelledOldPnlPositive += oldNet;
      if (oldNet < 0) cancelledOldPnlNegative += oldNet;
      if (cancelReasons[reason] != null) cancelReasons[reason]++;
    };

    const oldNet = Number(t.netPnL ?? 0);
    oldPnls.push(oldNet);

    if (!bar) {
      console.log(`  CANCEL: no TF bar at entryTimestamp`);
      bumpCancel("missing_bar");
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    const close = bar.close;
    let rvolOk = true;
    let rvolAtClose = null;
    if (filterMode === "RVOL") {
      rvolAtClose = rvolArr[barIdx];
      rvolOk = rvolAtClose != null && Number.isFinite(rvolAtClose) && rvolAtClose >= rvolMin;
    }

    const dirOk = passesDirectionConfirm(side, bar, directionConfirmMode, minBodyBias);
    const bodyBiasSide = getBodyBias(side, bar);

    if (opt.verbose) {
      console.log(
        `  bar close=${close} rvolAtClose=${rvolAtClose ?? "—"} rvolOk=${rvolOk} dirOk=${dirOk} ` +
        `bodyBias(${side})=${Number.isFinite(bodyBiasSide) ? bodyBiasSide.toFixed(3) : "—"}`
      );
    }

    if (!rvolOk) {
      console.log(`  CANCEL: RVOL gate (filterMode=RVOL)`);
      bumpCancel("rvol");
      await sleep(opt.delayMsPerTrade);
      continue;
    }
    if (!dirOk) {
      console.log(`  CANCEL: direction confirm`);
      bumpCancel("direction");
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    const newEntryPrice = close;
    if (looksLikeWrongSymbol(t.entryPrice, newEntryPrice)) {
      console.warn(
        `  WARN: close (${newEntryPrice}) far from oldEntry (${t.entryPrice}); likely symbol mismatch. CANCEL.`
      );
      bumpCancel("wrong_symbol");
      await sleep(opt.delayMsPerTrade);
      continue;
    }

    let finalEntryPrice = newEntryPrice;
    let fillTag = "@close";

    if (exceedsMaxWorseEntryChasePct(side, t.entryPrice, newEntryPrice, maxWorseEntryChasePct)) {
      const wPct = worseEntryChasePct(side, t.entryPrice, newEntryPrice);
      const limitPx = computeChaseLimitPrice(
        side,
        t.entryPrice,
        wPct,
        chaseLimitSteepPct,
        chaseLimitRelaxedWorsePct
      );
      console.log(
        `  Chase: worse=${wPct.toFixed(3)}% > max ${maxWorseEntryChasePct}% → limit @ ${Number.isFinite(limitPx) ? limitPx.toFixed(6) : limitPx} ` +
        `(steep>${chaseLimitSteepPct}% → relaxed ${chaseLimitRelaxedWorsePct}% vs oldEntry)`
      );
      const scan = scanChaseLimitPath({
        side,
        limitPrice: limitPx,
        entryBarIdx: barIdx,
        tfSorted,
        signalsByTs,
      });
      if (!scan.ok) {
        console.log(
          `  CANCEL: chase limit (${scan.reason}) after +${scan.barsWaited} bar(s) limit=${limitPx}`
        );
        bumpCancel(scan.reason);
        await sleep(opt.delayMsPerTrade);
        continue;
      }
      finalEntryPrice = scan.fillPrice;
      fillTag = `@chase-limit +${scan.barsWaited}bars`;
      limitFilledCount++;
    }

    const quality = classifyEntryQuality(side, t.entryPrice, finalEntryPrice);
    if (quality === "better") betterEntryCount++;
    else if (quality === "worse") worseEntryCount++;
    else sameEntryCount++;

    replayRows.push({
      idx,
      trade: t,
      side,
      oldNet,
      startLabel,
      usedStopMode,
      close,
      rvolAtClose,
      bodyBiasSide,
      fillTag,
      finalEntryPrice,
      entryDeltaPctText: getEntryDistancePctText(side, t.entryPrice, finalEntryPrice),
    });
    replayedEntryByIdx.set(idx, finalEntryPrice);

    await sleep(opt.delayMsPerTrade);
  }

  for (const row of replayRows) {
    const {
      idx,
      trade,
      side,
      oldNet,
      startLabel,
      usedStopMode,
      close,
      rvolAtClose,
      bodyBiasSide,
      fillTag,
      finalEntryPrice,
      entryDeltaPctText,
    } = row;
    const nextTrade = idx + 1 < trades.length ? trades[idx + 1] : null;
    const nextTradeReplayedEntryPrice = replayedEntryByIdx.get(idx + 1);
    const replayedExitPrice = computeReplayedExitPrice(
      trade,
      finalEntryPrice,
      nextTrade,
      nextTradeReplayedEntryPrice
    );
    const newNet = computeNetPnlFromTradeLike({
      side,
      entryPrice: finalEntryPrice,
      exitPrice: replayedExitPrice,
      positionValue: trade.positionValue,
      feeOpen: trade.feeOpen,
      feeClose: trade.feeClose,
    });
    newPnlsFilled.push(newNet);

    console.log(`\n${startLabel} bucket=${toIso(trade.entryTimestamp)} mode=${usedStopMode}`);
    console.log(
      `  FILL ${fillTag} close=${close} rvolAtClose=${rvolAtClose ?? "—"} bodyBias=${Number.isFinite(bodyBiasSide) ? bodyBiasSide.toFixed(3) : "—"} ` +
      `oldEntry=${trade.entryPrice} newEntry=${finalEntryPrice} oldExit=${trade.exitPrice} newExit=${replayedExitPrice} entryDelta=${entryDeltaPctText} ` +
      `oldPnL=${oldNet.toFixed(2)} newPnL=${newNet.toFixed(2)}`
    );
  }

  return {
    oldPnls,
    newPnlsFilled,
    cancelledCount,
    cancelReasons,
    limitFilledCount,
    cancelledOldPnlNet,
    cancelledOldPnlPositive,
    cancelledOldPnlNegative,
    betterEntryCount,
    worseEntryCount,
    sameEntryCount,
  };
}

async function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log(usage());
    process.exit(0);
  }

  if (opt.provider !== "bybit") {
    throw new Error(`Only provider=bybit supported (got ${opt.provider}).`);
  }
  if (opt.stopMode !== "exact" && opt.stopMode !== "proxy") {
    throw new Error(`Invalid stopMode=${opt.stopMode}. Use exact|proxy.`);
  }
  if (!Number.isFinite(opt.maxWorseEntryChasePct)) {
    throw new Error(`Invalid maxWorseEntryChasePct=${opt.maxWorseEntryChasePct}. Use a number (0 = off).`);
  }
  if (!Number.isFinite(opt.chaseLimitSteepPct) || opt.chaseLimitSteepPct < 0) {
    throw new Error(`Invalid chaseLimitSteepPct=${opt.chaseLimitSteepPct}. Must be >= 0.`);
  }
  if (!Number.isFinite(opt.chaseLimitRelaxedWorsePct)) {
    throw new Error(`Invalid chaseLimitRelaxedWorsePct=${opt.chaseLimitRelaxedWorsePct}. Must be a finite number (negative allowed).`);
  }

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
  const tfCandles = await fetchBybitRangeChunked({
    symbol: opt.symbol,
    interval: String(opt.tfMinutes),
    startMs: tfStartMs,
    endMs: tfEndMs,
  });
  console.log(`TF candles loaded: ${tfCandles.length}`);

  const tfSorted = sortAndDedupeByTime(tfCandles);
  await fs.writeFile("tfCandles.json", JSON.stringify(tfSorted, null, 2), "utf8");

  const signalMap = new Map();
  const signalsByTs = new Map();
  const needPrpSignals = opt.stopMode === "exact" || opt.maxWorseEntryChasePct > 0;

  if (needPrpSignals) {
    console.log("Generating PRP signals ...");
    const signals = PrpPivotPsarStrategy.generateSignals(tfSorted, strategyParams);
    for (const s of signals) {
      if (!s || typeof s.timestamp !== "number" || !s.type) continue;
      if (opt.stopMode === "exact") {
        signalMap.set(`${s.timestamp}:${s.type}`, s);
      }
      if (opt.maxWorseEntryChasePct > 0) {
        let e = signalsByTs.get(s.timestamp);
        if (!e) {
          e = { long: false, short: false };
          signalsByTs.set(s.timestamp, e);
        }
        if (s.type === "long") e.long = true;
        if (s.type === "short") e.short = true;
      }
    }
    const parts = [`count=${signals.length}`];
    if (opt.stopMode === "exact") parts.push(`signalMap=${signalMap.size}`);
    if (opt.maxWorseEntryChasePct > 0) parts.push(`chaseOppositeIdx=${signalsByTs.size} ts`);
    console.log(`PRP signals: ${parts.join(" · ")}`);
  } else {
    console.log("stopMode=proxy and chase off: skip PRP signal generation; triggerLevel = oldEntryPrice.");
  }

  const lookback = Number(strategyParams.rvolLookback ?? 0);
  const rvolMin = Number(strategyParams.rvolMin ?? 0);
  const filterMode = strategyParams.filterMode ?? "None";
  const directionConfirmMode = strategyParams.directionConfirmMode ?? "None";
  console.log(
    `Closed-bar gates: filterMode=${filterMode}` +
    (filterMode === "RVOL" ? ` (RVOL>=${rvolMin} lookback=${lookback})` : "") +
    ` · directionConfirmMode=${directionConfirmMode}` +
    ` · fill @ bar.close when gates pass` +
    (opt.maxWorseEntryChasePct > 0
      ? ` · chase: max=${opt.maxWorseEntryChasePct}% steep=${opt.chaseLimitSteepPct}% relaxed=${opt.chaseLimitRelaxedWorsePct}%`
      : " · maxWorseEntryChasePct=off")
  );

  const result = await runReplayClosed(opt, {
    trades,
    tfSorted,
    signalMap,
    strategyParams,
    signalsByTs,
  });
  printSummaryBlock({
    oldPnls: result.oldPnls,
    newPnlsFilled: result.newPnlsFilled,
    totalTrades: trades.length,
    cancelledCount: result.cancelledCount,
    cancelReasons: result.cancelReasons,
    limitFilledCount: result.limitFilledCount,
    cancelledOldPnlNet: result.cancelledOldPnlNet,
    cancelledOldPnlPositive: result.cancelledOldPnlPositive,
    cancelledOldPnlNegative: result.cancelledOldPnlNegative,
    betterEntryCount: result.betterEntryCount,
    worseEntryCount: result.worseEntryCount,
    sameEntryCount: result.sameEntryCount,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
