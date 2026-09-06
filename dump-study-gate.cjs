'use strict';
// The same 30-day dump study, run against Gate.io instead of Binance.
//
// Point of comparison: Binance needs three endpoints for klines / OI / taker and
// publishes no liquidation history at all. Gate's `contract_stats` returns OI,
// taker ratio, top-trader positioning AND liquidation volume in one call - so this
// also tests whether liquidations, the one high-value signal missing from the
// Binance study, actually predict anything.
//
// Same method as dump-study.cjs: features from the preceding window only, forward
// outcome measured after, odd/even split by symbol.
//
// Usage: node dump-study-gate.cjs [--symbols=40] [--drop=10] [--horizon=12]

const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const N_SYMBOLS = arg('symbols', 40);
const DUMP_PCT = arg('drop', 10);
const HORIZON_H = arg('horizon', 12);
const CACHE = path.join(__dirname, 'data', 'study-cache-gate');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

const G = 'https://api.gateio.ws/api/v4/futures/usdt';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { await sleep(500 * (i + 1)); }
  }
  return null;
}
async function cached(key, fn) {
  // Gate lists CJK-named meme perps (牛来_USDT, 龙虾_USDT). A plain
  // [^a-z0-9._-] -> "_" sanitize collapses those to the SAME filename, so the
  // second symbol silently reads the first one's klines. Suffix a hash of the
  // raw key so distinct symbols can never share a cache file.
  const safe = key.replace(/[^a-z0-9._-]/gi, '_') + '-' +
    require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 8);
  const f = path.join(CACHE, safe + '.json');
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} }
  const v = await fn();
  if (v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (_) {} }
  return v;
}

// Gate lists tokenized equities and commodities (XAU gold, SNDK, CL crude, QQQX,
// SKHYNIX, SOXL...) alongside crypto perps, and several rank in its top 10 by
// volume. Intersect with Binance's perp list to keep the universe crypto-only,
// and comparable with the Binance study.
async function cryptoOnly() {
  const info = await getJson('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const set = new Set();
  for (const s of info?.symbols || []) {
    if (s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING') {
      set.add(`${s.baseAsset}_USDT`);
    }
  }
  return set;
}

async function topSymbols(n) {
  const [t, crypto] = await Promise.all([getJson(`${G}/tickers`), cryptoOnly()]);
  if (!Array.isArray(t) || !crypto.size) return [];
  return t.filter(x => /_USDT$/.test(x.contract) && crypto.has(x.contract))
    .sort((a, b) => parseFloat(b.volume_24h_quote || 0) - parseFloat(a.volume_24h_quote || 0))
    .slice(0, n).map(x => x.contract);
}

// Gate candlesticks: newest last, fields o/h/l/c/v/t/sum.
const klines = c => cached(`k_${c}`, () =>
  getJson(`${G}/candlesticks?contract=${c}&interval=1h&limit=1000`));

// contract_stats caps at 100 rows per call, so 30 days of 1h needs paging back.
async function stats(c) {
  return cached(`stats_${c}`, async () => {
    let all = [], to = Math.floor(Date.now() / 1000);
    for (let page = 0; page < 8; page++) {
      const rows = await getJson(`${G}/contract_stats?contract=${c}&interval=1h&limit=100&to=${to}`);
      if (!Array.isArray(rows) || !rows.length) break;
      all = rows.concat(all);
      to = Number(rows[0].time) - 1;
      await sleep(120);
    }
    return all.length ? all : null;
  });
}

function atOrBefore(rows, tsKey, ts) {
  if (!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(rows[mid][tsKey]) <= ts) { best = rows[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch; else l -= ch;
  }
  const ag = g / n, al = l / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function build(sym, k, st) {
  const rows = [];
  const bars = k.map(x => ({ t: Number(x.t) * 1000, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +(x.sum || x.v) }))
                .sort((a, b) => a.t - b.t);
  const closes = bars.map(b => b.c), highs = bars.map(b => b.h), lows = bars.map(b => b.l), vols = bars.map(b => b.v);

  for (let i = 48; i < bars.length - HORIZON_H; i++) {
    const c = closes[i];
    if (!c) continue;
    let worst = 0;
    for (let j = i + 1; j <= i + HORIZON_H; j++) {
      const mv = ((lows[j] - c) / c) * 100;
      if (mv < worst) worst = mv;
    }
    const ts = bars[i].t, sec = Math.floor(ts / 1000);
    const ret = h => ((c - closes[i - h]) / closes[i - h]) * 100;
    const volAvg = vols.slice(i - 24, i).reduce((a, b) => a + b, 0) / 24;
    const hi48 = Math.max(...highs.slice(i - 48, i + 1));

    const s0 = atOrBefore(st, 'time', sec);
    const s6 = atOrBefore(st, 'time', sec - 6 * 3600);
    const s24 = atOrBefore(st, 'time', sec - 24 * 3600);
    const oiNow = s0 ? numOr(s0.open_interest_usd) : null;
    const oi6 = s6 ? numOr(s6.open_interest_usd) : null;
    const oi24 = s24 ? numOr(s24.open_interest_usd) : null;

    // Liquidations over the trailing 6h - the signal Binance does not publish.
    let longLiq = 0, shortLiq = 0, seen = 0;
    for (let q = st.length - 1; q >= 0; q--) {
      const t = Number(st[q].time);
      if (t > sec) continue;
      if (t < sec - 6 * 3600) break;
      longLiq += numOr(st[q].long_liq_usd) || numOr(st[q].long_liq_usd_new) || 0;
      shortLiq += numOr(st[q].short_liq_usd) || numOr(st[q].short_liq_usd_new) || 0;
      seen++;
    }
    const liqTotal = longLiq + shortLiq;

    rows.push({
      sym, ts,
      dumped: worst <= -DUMP_PCT ? 1 : 0,
      worst: +worst.toFixed(2),
      f: {
        ret4: +ret(4).toFixed(2),
        ret24: +ret(24).toFixed(2),
        rsi14: rsi(closes.slice(0, i + 1)),
        volSurge: volAvg ? +(vols[i] / volAvg).toFixed(2) : null,
        distFromHigh: +(((c - hi48) / hi48) * 100).toFixed(2),
        oiChg6: (oiNow && oi6) ? +(((oiNow - oi6) / oi6) * 100).toFixed(2) : null,
        oiChg24: (oiNow && oi24) ? +(((oiNow - oi24) / oi24) * 100).toFixed(2) : null,
        lsrTaker: s0 ? numOr(s0.lsr_taker) : null,
        lsrAccount: s0 ? numOr(s0.lsr_account) : null,
        topLsr: s0 ? numOr(s0.top_lsr_account) : null,
        // Liquidations as a share of open interest - comparable across coins.
        liqPctOfOi: (seen && oiNow) ? +((liqTotal / oiNow) * 100).toFixed(4) : null,
        // Which side got liquidated: >1 means longs were hit harder.
        liqSkew: (longLiq + shortLiq) > 0 ? +(longLiq / (shortLiq || 1)).toFixed(2) : null
      }
    });
  }
  return rows;
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

const BUCKETS = {
  ret4: [['< -5%', v => v < -5], ['-5..-1', v => v >= -5 && v < -1], ['-1..1', v => v >= -1 && v <= 1],
         ['1..5', v => v > 1 && v <= 5], ['> 5%', v => v > 5]],
  ret24: [['< -20%', v => v < -20], ['-20..-5', v => v >= -20 && v < -5], ['-5..5', v => v >= -5 && v <= 5],
          ['5..20', v => v > 5 && v <= 20], ['> 20%', v => v > 20]],
  rsi14: [['< 30', v => v < 30], ['30-50', v => v >= 30 && v < 50], ['50-70', v => v >= 50 && v < 70],
          ['70-80', v => v >= 70 && v < 80], ['>= 80', v => v >= 80]],
  volSurge: [['< 1x', v => v < 1], ['1-2', v => v >= 1 && v < 2], ['2-4', v => v >= 2 && v < 4], ['> 4x', v => v >= 4]],
  oiChg24: [['< -10', v => v < -10], ['-10..0', v => v >= -10 && v <= 0], ['0..10', v => v > 0 && v <= 10],
            ['10..30', v => v > 10 && v <= 30], ['> 30', v => v > 30]],
  oiChg6: [['< -5', v => v < -5], ['-5..0', v => v >= -5 && v <= 0], ['0..5', v => v > 0 && v <= 5], ['> 5', v => v > 5]],
  lsrTaker: [['< 0.85', v => v < 0.85], ['0.85-0.95', v => v >= 0.85 && v < 0.95],
             ['0.95-1.05', v => v >= 0.95 && v < 1.05], ['1.05-1.2', v => v >= 1.05 && v < 1.2], ['>= 1.2', v => v >= 1.2]],
  lsrAccount: [['< 1', v => v < 1], ['1-2', v => v >= 1 && v < 2], ['2-4', v => v >= 2 && v < 4], ['>= 4', v => v >= 4]],
  liqPctOfOi: [['0', v => v === 0], ['0-0.05', v => v > 0 && v < 0.05], ['0.05-0.2', v => v >= 0.05 && v < 0.2],
               ['0.2-1', v => v >= 0.2 && v < 1], ['>= 1', v => v >= 1]],
  liqSkew: [['< 0.5 (shorts hit)', v => v < 0.5], ['0.5-2', v => v >= 0.5 && v <= 2], ['> 2 (longs hit)', v => v > 2]],
  distFromHigh: [['< -20%', v => v < -20], ['-20..-10', v => v >= -20 && v < -10],
                 ['-10..-3', v => v >= -10 && v < -3], ['-3..0', v => v >= -3]]
};

(async () => {
  console.log(`\nDUMP STUDY · GATE.IO · last 30 days · 1h bars`);
  console.log(`a "dump" = falling ${DUMP_PCT}% within ${HORIZON_H}h\n`);
  const syms = await topSymbols(N_SYMBOLS);
  console.log(`  universe: top ${syms.length} Gate USDT perps by 24h quote volume`);

  let rows = [], done = 0;
  for (const sym of syms) {
    const k = await klines(sym);
    if (!Array.isArray(k) || k.length < 200) { done++; continue; }
    const st = await stats(sym);
    if (Array.isArray(st) && st.length) rows = rows.concat(build(sym, k, st));
    done++;
    process.stdout.write(`\r  fetched ${done}/${syms.length}  rows ${rows.length}    `);
    await sleep(250);
  }
  console.log('');

  if (!rows.length) { console.log('  NO DATA\n'); return; }
  const base = rows.filter(r => r.dumped).length / rows.length;
  const symList = [...new Set(rows.map(r => r.sym))].sort();
  const inTrain = r => symList.indexOf(r.sym) % 2 === 0;
  const rowsTr = rows.filter(inTrain), rowsTe = rows.filter(r => !inTrain(r));
  const rate = a => a.length ? a.filter(r => r.dumped).length / a.length : 0;
  // Each half must be scored against ITS OWN base rate. A pooled denominator
  // makes every lift wrong the moment the two halves differ in volatility - and
  // with ~20 symbols a half, one violent coin is enough to make them differ.
  const baseTr = rate(rowsTr), baseTe = rate(rowsTe);

  console.log(`  observations ${rows.length} across ${symList.length} symbols`);
  console.log(`  BASE RATE: ${(base * 100).toFixed(1)}%  ` +
              `(train ${(baseTr * 100).toFixed(1)}% / test ${(baseTe * 100).toFixed(1)}%)`);
  const skew = baseTr && baseTe ? Math.max(baseTr / baseTe, baseTe / baseTr) : Infinity;
  if (skew > 1.5) {
    console.log(`  ⚠ halves differ ${skew.toFixed(1)}x - the split is unbalanced, ` +
                `treat cross-half agreement as weak evidence`);
  }
  console.log('');

  console.log('  feature / bucket           n(train)  lift   n(test)  lift   (vs own half base)');
  for (const [feat, buckets] of Object.entries(BUCKETS)) {
    let printed = false;
    for (const [label, test] of buckets) {
      const sel = a => a.filter(r => r.f[feat] != null && test(r.f[feat]));
      const tr = sel(rowsTr), te = sel(rowsTe);
      if (tr.length < 150 || te.length < 150) continue;
      const pTr = rate(tr), pTe = rate(te);
      const [lo] = wilson(te.filter(r => r.dumped).length, te.length);
      const mark = (lo > baseTe && pTr > baseTr) ? ' **' : (pTe < baseTe && pTr < baseTr ? '  x' : '');
      if (!printed) { console.log(`  ${feat}`); printed = true; }
      console.log(`    ${label.padEnd(21)} ${String(tr.length).padStart(6)} ${(pTr / baseTr).toFixed(2).padStart(5)}x  ` +
                  `${String(te.length).padStart(6)} ${(pTe / baseTe).toFixed(2).padStart(5)}x` +
                  `   ${(pTr * 100).toFixed(1)}% / ${(pTe * 100).toFixed(1)}%${mark}`);
    }
  }
  console.log('\n  ** = test CI clears base and train agrees   x = below base on both\n');
  try {
    fs.writeFileSync(path.join(__dirname, 'data', 'dump-study-rows-gate.json'), JSON.stringify(rows));
    console.log('  raw rows saved for combination testing\n');
  } catch (_) {}
})();
