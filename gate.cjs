'use strict';
// Gate.io data layer. The scanner's ONLY source of market data.
//
// This module exists so the scanner owns its own data end to end. The previous
// version pulled its candidate list from tamad-scanner and its prices from the OI
// app, which meant it never actually detected anything - it re-scored someone
// else's detection, and went blind whenever that service restarted.
//
// Gate is the ONLY source because `contract_stats` returns open interest, taker ratio,
// top-trader positioning AND liquidation volume in one call. Binance needs three
// endpoints for a subset of that and publishes no liquidation history at all.
// Liquidation share of OI was the most train/test-stable dump signal measured
// (5.98x train / 6.28x test over 36,029 hourly observations).
//
// Nothing but Gate is contacted. Its own `contract_type` field classifies the
// tokenized equities and commodities (XAU gold, SNDK, CL crude, QQQX, SKHYNIX,
// SOXL, XAG) that rank high by volume and behave nothing like crypto, so no
// second exchange is needed to tell them apart.

const G = 'https://api.gateio.ws/api/v4/futures/usdt';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function getJson(url, { tries = 3, timeout = 20000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      // 429 is a budget problem, not a broken request - back off and retry.
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      // A timeout has already spent its budget; retrying it just overruns the
      // poll interval. Only retry connection-level failures.
      if (e && e.name === 'AbortError') break;
      await sleep(400 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('no response');
}

// ── universe ───────────────────────────────────────────────────────────────
let _cryptoSet = null, _cryptoAt = 0;

// Gate classifies its own contracts. `contract_type` is empty for crypto and
// carries "stocks" (392), "indices" (16), "metals" (13), "commodities" (3) or
// "forex" (3) for the tokenized-asset perps that would otherwise pollute a
// volume-ranked universe - XAU gold, SNDK, CL crude, QQQX, SOXL and the rest.
//
// This replaced an earlier filter that intersected with Binance's perp list,
// which was wrong twice over: Binance prefixes its small-unit contracts
// (1000PEPE, 1000SHIB, 1000BONK - 15 of them), so those coins never matched and
// were silently dropped from the universe; and "not listed on Binance" is not
// the same as "not crypto", so genuine Gate-only tokens were excluded too.
// Using the listing exchange's own classification fixes both, and removes the
// scanner's last dependency on a service other than Gate.
async function cryptoPerps() {
  if (_cryptoSet && Date.now() - _cryptoAt < 3600000) return _cryptoSet;
  const list = await getJson(`${G}/contracts`, { timeout: 20000 });
  const set = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.name) continue;
    if (c.contract_type) continue;          // stocks / indices / metals / commodities / forex
    if (c.in_delisting) continue;
    set.add(c.name);
  }
  // Keep the last good set on a failed fetch rather than silently falling back
  // to an unfiltered universe.
  if (set.size) { _cryptoSet = set; _cryptoAt = Date.now(); }
  return _cryptoSet || set;
}

// One call, every symbol: last price, 24h change, 24h volume, funding.
async function tickers() {
  const t = await getJson(`${G}/tickers`, { timeout: 20000 });
  return Array.isArray(t) ? t : [];
}

// Binance 24h volume, keyed to Gate contract names.
//
// Ranking by GATE volume alone is not the same as ranking by market importance:
// BR trades $793K on Gate and $31.1M on Binance, so it sat at Gate rank #105 and
// was never scanned, while the older Binance-based scanner had it as a top name.
// We still READ every number from Gate - this only decides which coins are worth
// looking at. If Binance is unreachable the caller falls back to Gate ranking.
let _binVol = null, _binAt = 0;
async function binanceVolumes() {
  if (_binVol && Date.now() - _binAt < 3600000) return _binVol;
  const rows = await getJson('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 20000 });
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const sym = String(r.symbol || '');
    if (!sym.endsWith('USDT')) continue;
    // Binance prefixes small-unit contracts (1000PEPE, 1000SHIB, 1M...). Strip it
    // so the key matches Gate's plain name; the quote volume is USDT either way.
    const base = sym.slice(0, -4).replace(/^(1000+|1M)/, '');
    const v = parseFloat(r.quoteVolume || 0);
    if (!base || !Number.isFinite(v)) continue;
    const key = `${base}_USDT`;
    map.set(key, Math.max(map.get(key) || 0, v));
  }
  if (map.size) { _binVol = map; _binAt = Date.now(); }
  return _binVol || map;
}

// Top N crypto perps. Ranked by the LARGER of the coin's Gate and Binance 24h
// volume, so a coin that matters on either venue gets scanned. Falls back to an
// unfiltered list only if the contracts endpoint has never answered - and says
// so, so the caller can flag it rather than quietly ranking gold futures.
async function universe(n, tickerRows) {
  const rows = tickerRows || await tickers();
  let crypto = null, binVol = null;
  try { crypto = await cryptoPerps(); } catch (_) {}
  try { binVol = await binanceVolumes(); } catch (_) {}

  const filtered = rows.filter(x => /_USDT$/.test(x.contract) && (!crypto || crypto.has(x.contract)));
  const use = (crypto && filtered.length) ? filtered : rows.filter(x => /_USDT$/.test(x.contract));

  // Rank by each coin's BEST POSITION on either venue, not by the larger raw
  // volume. Volume-max lets the bigger exchange dominate: taking max($ Gate,
  // $ Binance) filled the list with Binance majors and pushed Gate-only tokens
  // like EDGEX (Gate #113, not listed on Binance) straight out of the top 150.
  // Comparing positions instead is symmetric - a coin ranked #40 on either venue
  // is worth scanning, whichever venue that is.
  const rows2 = use.map(x => ({
    contract: x.contract,
    gateVol: parseFloat(x.volume_24h_quote || 0) || 0,
    binVol: binVol ? (binVol.get(x.contract) || 0) : 0
  }));
  const gateRank = new Map(), binRank = new Map();
  rows2.slice().sort((a, b) => b.gateVol - a.gateVol)
    .forEach((x, i) => gateRank.set(x.contract, x.gateVol > 0 ? i + 1 : Infinity));
  rows2.slice().sort((a, b) => b.binVol - a.binVol)
    .forEach((x, i) => binRank.set(x.contract, x.binVol > 0 ? i + 1 : Infinity));

  const scored = rows2.map(x => {
    const gr = gateRank.get(x.contract), br = binRank.get(x.contract);
    return { ...x, gateRank: gr, binRank: br, bestRank: Math.min(gr, br),
             rankVenue: br < gr ? 'binance' : 'gate' };
  }).filter(x => Number.isFinite(x.bestRank))
    .sort((a, b) => a.bestRank - b.bestRank || b.gateVol - a.gateVol)
    .slice(0, n);

  return {
    filtered: Boolean(crypto && filtered.length),
    rankedByBoth: Boolean(binVol && binVol.size),
    symbols: scored.map(x => x.contract),
    volumes: new Map(scored.map(x => [x.contract, x]))
  };
}

// ── per-symbol series ──────────────────────────────────────────────────────
// Gate returns oldest-first for both. Normalised to plain numbers here so no
// caller has to remember which fields arrive as strings.

async function klines(contract, limit = 220, interval = '1h') {
  const k = await getJson(`${G}/candlesticks?contract=${encodeURIComponent(contract)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`);
  if (!Array.isArray(k)) return [];
  return k.map(x => ({
    t: num(x.t) * 1000, o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c),
    v: num(x.v), quote: num(x.sum)
  })).filter(x => x.c != null).sort((a, b) => a.t - b.t);
}

// 48 rows, not 24: oiChg24 needs the row 24 hours back to still be present, and
// at limit=30 that sits 5 rows from the end with no margin for a gap in the feed.
async function stats(contract, limit = 48, interval = '1h') {
  const s = await getJson(`${G}/contract_stats?contract=${encodeURIComponent(contract)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`);
  if (!Array.isArray(s)) return [];
  return s.map(x => {
    const oi = num(x.open_interest_usd);
    // Gate publishes both a cumulative and a "_new" per-interval liquidation
    // figure. The per-interval one is what belongs in an hourly feature; summing
    // the cumulative field would leak the whole history into every row.
    const longLiq = num(x.long_liq_usd_new) ?? num(x.long_liq_usd) ?? 0;
    const shortLiq = num(x.short_liq_usd_new) ?? num(x.short_liq_usd) ?? 0;
    const totalLiq = longLiq + shortLiq;
    return {
      t: num(x.time) * 1000,
      oiUsd: oi,
      oi: num(x.open_interest),
      markPrice: num(x.mark_price),
      lsrTaker: num(x.lsr_taker),
      lsrAccount: num(x.lsr_account),
      topLsrSize: num(x.top_lsr_size),
      longLiqUsd: longLiq,
      shortLiqUsd: shortLiq,
      totalLiqUsd: totalLiq,
      // Liquidation volume as a share of open interest. Absolute liquidation
      // dollars are meaningless across coins of different size; this is the form
      // that actually separated dumps.
      liqPctOfOi: oi > 0 ? +((totalLiq / oi) * 100).toFixed(4) : null,
      // >1 means longs are the ones being liquidated, <1 means shorts are being
      // squeezed. Short squeezes measured as the ones that precede dumps.
      liqSkew: shortLiq > 0 ? +(longLiq / shortLiq).toFixed(3) : (longLiq > 0 ? 999 : null),
      fundingRate: num(x.last_funding_rate)
    };
  }).filter(x => x.t != null).sort((a, b) => a.t - b.t);
}

module.exports = { getJson, tickers, universe, klines, stats, cryptoPerps, binanceVolumes, G };
