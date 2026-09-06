'use strict';
// Feature extraction and dump scoring.
//
// EVERY threshold and weight below comes from one measurement: 30 days of Gate
// 1h bars, 36,029 observations across 39 crypto perps, outcome = "did price fall
// 10% within the next 12h". Base rate 6.0%. Symbols split odd/even into train and
// test, each half scored against ITS OWN base rate. Lifts quoted as train/test.
// Reproduce with: node dump-study-gate.cjs --symbols=40
//
// Two rules from that study shape everything here:
//
//  1. Open interest is the signal, in EITHER direction. A parabola that is still
//     building and one that is violently unwinding both precede dumps. Quiet OI
//     (-5%..+5% over 6h) sits at 0.5x - half the base rate.
//
//  2. Taker ratio is ANTI-predictive at the extremes, on both exchanges tested.
//     Gate lsr_taker < 0.85 -> 0.83x/0.68x. Binance taker < 0.85 -> 0.38x/0.53x.
//     Only the neutral 0.95-1.05 band is elevated. The old scanner awarded its
//     single largest bonus (+40) for taker < 0.80, and the auto-trader's live
//     short gate fires on taker < 0.95 into a 0.82x dump rate - worse than
//     random. That is inverted here, deliberately, and must not be "fixed" back.

const IND = require('./indicators.cjs');

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (a, b) => (a != null && b) ? +(((a - b) / b) * 100).toFixed(3) : null;

// Open interest, taker ratio and liquidations for one contract_stats series.
//
// `intervalMs` is the spacing of the series, needed only to tell whether the
// newest row is a still-forming bar. Extracted so the 1h series that drives the
// tiers and the 1m/5m/15m/4h series that only feed the display run through
// exactly one implementation - two copies would drift, and the tier path is the
// one that must not.
function statMetrics(stats, intervalMs) {
  const f = {};
  if (!Array.isArray(stats) || !stats.length) return f;
  const s = stats[stats.length - 1];
  // Positional values (OI, taker ratio, funding) are correct from the newest row
  // - they are levels, not accumulations.
  f.oiUsd = s.oiUsd;
  f.lsrTaker = s.lsrTaker;
  f.lsrAccount = s.lsrAccount;
  // Top-trader position ratio. Gate has always returned it and nothing read it.
  // Measured: the 0.7-1 band sits at 2.05x test / 1.36x train (n=1811) - the
  // train/test gap is wide enough that it is surfaced as data, never scored.
  f.topLsr = s.topLsrSize;
  f.fundingRate = s.fundingRate;
  f.fundingPct = s.fundingRate != null ? +(s.fundingRate * 100).toFixed(4) : null;
  const at = k => stats[stats.length - 1 - k]?.oiUsd;
  f.oiChg1 = pct(s.oiUsd, at(1));
  f.oiChg6 = pct(s.oiUsd, at(6));
  f.oiChg24 = pct(s.oiUsd, at(24));
  f.statRows = stats.length;

  // Liquidations ACCUMULATE through a bar, so the newest row is the bar still
  // forming and reads near zero for most of its life. The study measured
  // COMPLETED bars; reading the partial one made liqPctOfOi look like 0 almost
  // always and silently disabled the two IMMINENT rules that need it.
  const barStart = Math.floor(Date.now() / intervalMs) * intervalMs;
  const partial = s.t >= barStart;
  const closed = partial ? stats.slice(0, -1) : stats;
  const lastClosed = closed[closed.length - 1] || null;
  f.liqPctOfOi = lastClosed ? lastClosed.liqPctOfOi : null;
  f.liqSkew = lastClosed ? lastClosed.liqSkew : null;
  f.liqHourPartial = partial;
  // A 6-bar view as well: one quiet bar after a violent one should not read as
  // "nothing is happening".
  const win = closed.slice(-6);
  const liq6 = win.reduce((a, r) => a + (r.totalLiqUsd || 0), 0);
  f.liqPctOfOi6h = s.oiUsd > 0 ? +((liq6 / s.oiUsd) * 100).toFixed(4) : null;
  const l6 = win.reduce((a, r) => a + (r.longLiqUsd || 0), 0);
  const s6 = win.reduce((a, r) => a + (r.shortLiqUsd || 0), 0);
  f.liqSkew6h = s6 > 0 ? +(l6 / s6).toFixed(3) : (l6 > 0 ? 999 : null);
  return f;
}

// ── features ───────────────────────────────────────────────────────────────
// All computed from the PRECEDING window only. Nothing here may read a bar that
// closes after the moment being scored.
function features(bars, stats) {
  const f = {};
  if (Array.isArray(bars) && bars.length >= 25) {
    const c = bars[bars.length - 1].c;
    f.price = c;
    f.ret4 = pct(c, bars[bars.length - 5]?.c);
    f.ret24 = pct(c, bars[bars.length - 25]?.c);
    const look = bars.slice(-168);
    const high = Math.max(...look.map(b => b.h).filter(Number.isFinite));
    f.high7d = high;
    f.distFromHigh = high > 0 ? +(((c - high) / high) * 100).toFixed(3) : null;
    // Volume surge vs the trailing 24h mean, excluding the bar being measured.
    const vols = bars.slice(-25, -1).map(b => b.quote ?? b.v).filter(Number.isFinite);
    const meanVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const lastVol = bars[bars.length - 1].quote ?? bars[bars.length - 1].v;
    f.volSurge = meanVol > 0 && Number.isFinite(lastVol) ? +(lastVol / meanVol).toFixed(2) : null;
    const ta = IND.compute(bars);
    f.rsi14 = ta.rsi;
    f.atrPct = ta.atrPct;
    f.adx = ta.adx;
    f.trend = ta.trend;
    f.volPct = ta.volPct;
    f.bars = bars.length;
  }
  if (Array.isArray(stats) && stats.length) Object.assign(f, statMetrics(stats, 3600000));
  return f;
}

// ── timeframe context ──────────────────────────────────────────────────────
// Uniform metrics on several timeframes, so the same coin can be read at 15m,
// 1h, 4h and 1d.
//
// IMPORTANT: this is CONTEXT ONLY. Every tier rule is measured on 1h bars and
// stays on 1h bars. Recomputing a 6.15x lift on 15m data would be quoting a
// number that was never measured - the thresholds (+30% OI, RSI 80, -10% off the
// high) mean different things over different windows. Switching timeframe in the
// UI changes what you are LOOKING at, never what the tier says.
//
// chgN is the change over N bars OF THAT TIMEFRAME, so it is self-describing:
// chg24 is 6h on the 15m view, 24h on 1h, 4 days on 4h.
function tfMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 26) return null;
  const c = bars[bars.length - 1].c;
  const back = n => bars[bars.length - 1 - n]?.c;
  const chg = n => { const p = back(n); return p ? +(((c - p) / p) * 100).toFixed(2) : null; };
  const win = bars.slice(-168);
  const high = Math.max(...win.map(b => b.h).filter(Number.isFinite));
  const low = Math.min(...win.map(b => b.l).filter(Number.isFinite));
  const vols = bars.slice(-25, -1).map(b => b.quote ?? b.v).filter(Number.isFinite);
  const mean = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const lastVol = bars[bars.length - 1].quote ?? bars[bars.length - 1].v;
  const ta = IND.compute(bars);
  return {
    chg1: chg(1), chg4: chg(4), chg6: chg(6), chg24: chg(24),
    rsi: ta.rsi, atrPct: ta.atrPct, adx: ta.adx, trend: ta.trend, volPct: ta.volPct,
    volSurge: mean > 0 && Number.isFinite(lastVol) ? +(lastVol / mean).toFixed(2) : null,
    distFromHigh: high > 0 ? +(((c - high) / high) * 100).toFixed(2) : null,
    distFromLow: low > 0 ? +(((c - low) / low) * 100).toFixed(2) : null,
    bars: bars.length
  };
}

// Build a higher timeframe from lower-timeframe bars. 4h and 1d come free from
// the 1h series we already fetch, so only 15m needs its own request.
function aggregate(bars, n) {
  if (!Array.isArray(bars) || bars.length < n) return [];
  const out = [];
  // Walk from the newest backwards so the most recent bucket is the complete one
  // that ends at the latest bar, rather than an arbitrary offset from the start.
  for (let end = bars.length; end - n >= 0; end -= n) {
    const g = bars.slice(end - n, end);
    out.unshift({
      t: g[0].t, o: g[0].o, c: g[g.length - 1].c,
      h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)),
      v: g.reduce((a, x) => a + (x.v || 0), 0),
      quote: g.reduce((a, x) => a + (x.quote || 0), 0)
    });
  }
  return out;
}

// Who is in control, from open interest against price over the same window.
//
// This is DESCRIPTIVE, not a prediction, and it is deliberately not scored.
// Measured on 30 days of Gate data:
//   longs building      1.74x train / 1.28x test   (6.41x / 4.81x on moving coins)
//   long capitulation   1.00x / 1.03x              (4.74x / 5.42x on moving coins)
//   shorts building     0.46x / 1.47x  - train and test disagree, so no claim
//   short squeeze       0.55x / 0.58x  - BELOW base on both halves
//
// The only durable finding is the last one: price rising on FALLING open interest
// is shorts covering rather than real buying, and dumps are LESS likely there. On
// coins that are actually moving the other quadrants do separate, but they mostly
// restate rules the tiers already apply, so folding them into the score would be
// double-counting the same evidence.
function control(chgPct, oiChgPct, dead = 1) {
  if (chgPct == null || oiChgPct == null) return null;
  const p = Math.abs(chgPct) < dead ? 0 : Math.sign(chgPct);
  const o = Math.abs(oiChgPct) < dead ? 0 : Math.sign(oiChgPct);
  if (!p && !o) return { state: 'QUIET', who: 'neither', why: 'price and open interest both flat' };
  if (p >= 0 && o > 0) return { state: 'LONGS_BUILDING', who: 'longs',
    why: 'price up on rising open interest - new longs entering', lift: '1.74x/1.28x' };
  if (p < 0 && o > 0) return { state: 'SHORTS_BUILDING', who: 'shorts',
    why: 'price down on rising open interest - new shorts entering', lift: '0.46x/1.47x' };
  if (p > 0 && o < 0) return { state: 'SHORT_SQUEEZE', who: 'shorts covering',
    why: 'price up on FALLING open interest - covering, not real buying',
    lift: '0.55x/0.58x', caution: 'measured BELOW the base rate on both halves' };
  if (p < 0 && o < 0) return { state: 'LONGS_CAPITULATING', who: 'longs exiting',
    why: 'price down on falling open interest - longs closing out', lift: '1.00x/1.03x' };
  return { state: 'QUIET', who: 'neither', why: 'no clear direction' };
}

// ── tiers ──────────────────────────────────────────────────────────────────
// Tiers come from COMBINATIONS measured jointly, never from multiplying
// individual lifts together. oiChg24 and ret24 are correlated; treating them as
// independent would manufacture confidence that was never measured.
//
// Each rule carries the exact train/test lift it was measured at, so anyone
// reading a live alert can see the evidence behind the tier.
// A weighted stack ported from tamad-scanner's parabolic scan, which measured
// sharper than anything here: its top band hit 71% where our best IMMINENT rule
// hits 40% (Binance data), and 76% on Gate. Two of its components were measured
// BACKWARDS on its own data and are corrected here:
//
//   taker < 1.0  was its single largest term (+30). Inside its own gate that
//                bucket hit 37.1% against 44.8% for taker >= 1.0 - it paid most
//                for the worse half. Deleted entirely, consistent with the
//                anti-predictive finding documented at the top of this file.
//   within 5% of high  was +5. Measured 31.2% against 51.0% for 10%+ BELOW the
//                high. Inverted.
//   OI falling only  earned points; OI rising earned none, despite rising >30%
//                measuring 6.15x against 3.06x for falling. Now scored in both
//                directions, matching finding (1) above.
//
// Corrected, the same rule went 71.1% -> 76.1% while firing MORE often, so this
// is not a trade of precision for coverage.
function stackScore(f) {
  let s = 0;
  if (f.ret24 != null) {
    if (f.ret24 >= 50) s += 20; else if (f.ret24 >= 30) s += 10;
    if (f.ret24 >= 80) s += 15;
  }
  if (f.rsi14 != null) {
    if (f.rsi14 >= 80) s += 20; else if (f.rsi14 >= 70) s += 10;
    if (f.rsi14 >= 87) s += 10;
  }
  if (f.fundingPct != null) {
    if (f.fundingPct > 0.1) s += 15; else if (f.fundingPct > 0.05) s += 8;
  }
  if (f.volSurge != null && f.volSurge >= 2.0) s += 12;
  if (f.distFromHigh != null && f.distFromHigh < -10) s += 15;
  if (f.oiChg24 != null) {
    if (Math.abs(f.oiChg24) > 30) s += 20; else if (Math.abs(f.oiChg24) > 10) s += 10;
  }
  return Math.min(100, Math.round(s));
}

const RULES = [
  // PRIME is the corrected stack only. A second candidate - ret24>=30 with the
  // price 10%+ off its high - looked like the best rule found on Binance (9.61x)
  // and did NOT replicate on Gate (7.65x), landing below the IMMINENT rule below
  // it. It is deliberately absent. Do not add it back on the Binance number.
  { tier: 'PRIME', lift: '11.41x/9.67x', why: 'pump + RSI + volume + funding + OI stack',
    test: f => f.ret24 >= 30 && stackScore(f) >= 70 },

  { tier: 'IMMINENT', lift: '8.81x/8.36x', why: 'OI +30% and 10%+ off the high',
    test: f => f.oiChg24 > 30 && f.distFromHigh != null && f.distFromHigh < -10 },
  { tier: 'IMMINENT', lift: '8.76x/7.62x', why: 'liquidations firing into a +20% 24h run',
    test: f => f.liqPctOfOi >= 0.2 && f.ret24 > 20 },
  { tier: 'IMMINENT', lift: '8.38x/7.05x', why: 'heavy liquidations, already off the high',
    test: f => f.liqPctOfOi >= 1 && f.distFromHigh != null && f.distFromHigh < -10 },

  { tier: 'DANGER', lift: '8.96x/6.43x', why: 'up more than 20% in 24h',
    test: f => f.ret24 > 20 },
  { tier: 'DANGER', lift: '7.64x/6.15x', why: 'open interest up more than 30% in 24h',
    test: f => f.oiChg24 > 30 },
  { tier: 'DANGER', lift: '5.98x/6.28x', why: 'liquidation volume above 1% of open interest',
    test: f => f.liqPctOfOi >= 1 },
  { tier: 'DANGER', lift: '6.63x/5.80x', why: 'more than 20% below the 7d high',
    test: f => f.distFromHigh != null && f.distFromHigh < -20 },
  { tier: 'DANGER', lift: '5.94x/5.48x', why: 'violent 4h move',
    test: f => f.ret4 != null && Math.abs(f.ret4) > 5 },

  { tier: 'WARNING', lift: '3.94x/3.54x', why: 'open interest moving fast (6h)',
    test: f => f.oiChg6 != null && Math.abs(f.oiChg6) > 5 },
  { tier: 'WARNING', lift: '4.10x/3.97x', why: 'liquidations elevated',
    test: f => f.liqPctOfOi >= 0.2 },
  { tier: 'WARNING', lift: '2.58x/3.06x', why: 'open interest unwinding hard (24h)',
    test: f => f.oiChg24 != null && f.oiChg24 < -10 },
  { tier: 'WARNING', lift: '2.77x/2.32x', why: 'RSI stretched',
    test: f => f.rsi14 != null && f.rsi14 >= 80 },
  { tier: 'WARNING', lift: '2.58x/2.10x', why: 'volume surge above 4x',
    test: f => f.volSurge != null && f.volSurge > 4 },
  { tier: 'WARNING', lift: '2.04x/1.42x', why: 'shorts being squeezed',
    test: f => f.liqSkew != null && f.liqSkew < 0.5 }
];

const RANK = { PRIME: 4, IMMINENT: 3, DANGER: 2, WARNING: 1, QUIET: 0 };

// Conditions measured BELOW the base rate. These are not "no signal", they are
// evidence against a dump, and they suppress the tier rather than just failing to
// raise it.
const DAMPENERS = [
  { lift: '0.37x/0.27x', why: 'sitting at its 7d high, OI quiet',
    test: f => f.distFromHigh != null && f.distFromHigh > -3 &&
               (f.oiChg6 == null || Math.abs(f.oiChg6) < 5) },
  { lift: '0.25x/0.25x', why: 'flat 24h and flat OI - nothing is happening',
    test: f => f.ret24 != null && Math.abs(f.ret24) < 5 &&
               f.oiChg24 != null && Math.abs(f.oiChg24) < 10 },
  // Only counted when stats actually arrived, so "Gate returned nothing" is never
  // mistaken for "genuinely zero liquidations".
  { lift: '0.27x/0.14x', why: 'no liquidations at all this hour',
    test: f => f.statRows > 0 && f.liqPctOfOi === 0 }
];

function grade(f) {
  const matched = RULES.filter(r => { try { return r.test(f); } catch (_) { return false; } });
  const damp = DAMPENERS.filter(d => { try { return d.test(f); } catch (_) { return false; } });

  let tier = 'QUIET';
  for (const m of matched) if (RANK[m.tier] > RANK[tier]) tier = m.tier;

  // Dampeners cost ONE tier no matter how many fire. The tier rules are measured
  // combinations with 6-8x lift; the dampeners are single conditions. Letting
  // three weak signals cancel a strong measured combination would be stacking
  // evidence that was never jointly measured. It cannot rescue a QUIET, and it
  // cannot veto - "less likely than base" is not "impossible".
  if (damp.length && RANK[tier] > 0) {
    tier = ['QUIET', 'WARNING', 'DANGER', 'IMMINENT', 'PRIME'][RANK[tier] - 1];
  }

  // Score is for RANKING WITHIN a tier only - it is not a probability.
  //
  // Driven by the STRONGEST rule that fired, plus a small bonus per corroborating
  // rule. Summing the lifts instead (the obvious approach) saturates at the 100
  // cap almost immediately - three mid-strength rules already exceed it - which
  // flattens every strong candidate to the same number and destroys the ranking
  // this score exists to provide. It also double-counts: oiChg24 and ret24 are
  // correlated, so adding them treats one piece of evidence as two.
  const lifts = matched.map(m => parseFloat(m.lift.split('/')[1])).filter(Number.isFinite);
  let score = 0;
  if (lifts.length) score = (Math.max(...lifts) - 1) * 10 + (lifts.length - 1) * 3;
  for (const d of damp) score -= 15;

  // Anti-signal, stated loudly because it is the exact mistake the old scanner
  // and the live auto-trader both make. Not a veto - just no longer a bonus.
  const notes = [];
  if (f.lsrTaker != null && (f.lsrTaker < 0.85 || f.lsrTaker >= 1.2)) {
    notes.push(`taker ${f.lsrTaker.toFixed(2)} is an EXTREME — measured 0.68-0.82x, ` +
               `i.e. dumps are LESS likely here. Not scored as bearish.`);
  }

  return {
    tier,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: matched.map(m => `${m.why} (${m.lift})`),
    dampeners: damp.map(d => `${d.why} (${d.lift})`),
    notes,
    ruleCount: matched.length
  };
}

module.exports = { features, grade, stackScore, tfMetrics, statMetrics, control, aggregate, RULES, DAMPENERS };
