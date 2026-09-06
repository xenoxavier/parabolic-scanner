<div align="center">

# 📉 Parabolic Scanner

**Watches 150 crypto perpetuals on Gate.io and flags the ones most likely to fall hard in the next 12 hours.**

_It ranks and records — it never places a trade._

![status](https://img.shields.io/badge/status-live-brightgreen?style=for-the-badge)
![port](https://img.shields.io/badge/port-8802-blue?style=for-the-badge)
![data](https://img.shields.io/badge/data-Gate.io-FF6B35?style=for-the-badge)
![trades](https://img.shields.io/badge/places%20trades-never-lightgrey?style=for-the-badge)
![license](https://img.shields.io/badge/license-ISC-green?style=for-the-badge)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/comvibewithmir)
[![Donate USDT (BEP20)](https://img.shields.io/badge/Donate-USDT_BEP20-26A17B?style=for-the-badge&logo=tether&logoColor=white)](#-donate)

[Overview](#-overview) ·
[Quick Start](#-quick-start) ·
[How grading works](#-how-a-coin-gets-graded) ·
[Data source](#-where-the-data-comes-from) ·
[API](#-api) ·
[Security](#-security) ·
[Honest summary](#-the-honest-summary)

</div>

* * *

> **Parabolic Scanner is a detector, not a strategy.** Every tier it assigns is
> backed by a number measured on 30 days of Gate data, and that number is printed
> on the alert. It opens no positions and holds no ledger. What you do with a
> PRIME is your call — read [The honest summary](#-the-honest-summary) first.

* * *

## 📰 News

- **2026-09-04** — Stop widened `+12%` → `+15%` after `patience-study.cjs` (16W / 12L, **+$0.83/trade** vs 14W / 14L at +12%). Every outcome record now stamps the `stopPct` it ran under so a rule change never blends two populations.
- **Hysteresis + cooldown** — a new tier must hold for **3 consecutive polls (90s)** before it commits, plus a **one-hour cooldown per coin** on alerts. Before this, one coin fired 5 alerts in an hour by flapping across a threshold.
- **PRIME ported from tamad-scanner** — its parabolic band measured sharper than anything derived here (76% hit rate). Three of its components measured *backwards* on its own data and were corrected: `71.1% → 76.1%` while firing more often.
- **Universe ranking** — switched from volume-max to **best position on Gate _or_ Binance**, so Gate-only tokens (EDGEX, Gate #113) are no longer pushed out by Binance majors.
- **Live outcome tracker** — `outcomes.cjs` now records what actually happens after every PRIME / IMMINENT signal on the live 150-coin universe, appended to `data/outcomes.jsonl` and never rewritten.
- **CJK cache-key fix** — Gate's meme perps (`牛来`, `龙虾`) sanitised to the same filename and read each other's data. Keys are hash-suffixed now.

* * *

## ✨ Overview

Every **30 seconds** the scanner asks Gate for the price of every coin in its
universe. Every **5 minutes** it pulls the deeper data — open interest,
liquidations, taker flow, funding — and re-grades each coin into one of five
tiers, from `QUIET` to `PRIME`.

A tier is **not an opinion**. Every rule behind it carries the exact train / test
lift it was measured at over 36,029 hourly observations, and those numbers travel
with the signal all the way to the Discord card. `PRIME` reaches −10% within 12h
in **78%** of backtest episodes.

The process is split in two so restarting the web page never interrupts the
scanning. The brain (`scanner.cjs`) polls, grades, tracks outcomes and sends
alerts. The page (`server.cjs`) serves a mobile dashboard and a read-only JSON
API on **port 8802**. State lives in `data/` and survives restarts.

## 🎯 Highlights

- 📉 **One job** — rank the 150 coins most likely to dump, and record what happens next. No positions, no ledger, no execution.
- 🔬 **Every rule is cited** — `score.cjs` holds each tier rule with its measured lift. Nothing is a hunch; the alert shows the number.
- 🛰️ **One data source** — all graded numbers come from Gate's `contract_stats` (OI + taker + top-trader + liquidations in one call). Binance is touched once an hour for volume ranking only.
- 🧮 **Measured combinations, not stacked lifts** — tiers come from conditions measured *jointly*, never from multiplying correlated signals together.
- 🪤 **Hysteresis + cooldown** — 3-poll confirmation and a 1h per-coin cooldown kill alert flapping.
- 📊 **Live outcome tracking** — each PRIME / IMMINENT entry is followed poll-by-poll to target, stop or timeout, appended immutably.
- 🔔 **Discord alerts** — rich card with five timeframes of price, OI, liquidations, positioning, short levels and the coin's own track record.
- 🧩 **Read-only API** — `/api/scan`, `/api/outcomes`, `/api/bars`, gzipped and `no-store`.

* * *

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js 18+** (uses the built-in global `fetch`, `FormData`, `AbortSignal.timeout`)
- **pm2** for process management
- Outbound HTTPS to `api.gateio.ws` and `fapi.binance.com` — no API keys, both are public market-data endpoints

### 2. Install

```bash
cd /root/parabolic-scanner
npm install            # only dependency: @napi-rs/canvas, for the alert chart
```

### 3. Configure Discord alerts (optional)

Create `data/webhooks.json` and lock it down:

```json
{
  "enabled": true,
  "tiers": ["PRIME"],
  "urls": ["https://discord.com/api/webhooks/..."],
  "format": "card",
  "template": "fc {base} 1h % oi funding liq"
}
```

```bash
chmod 600 data/webhooks.json
```

The scanner runs fine without this file — alerts are simply disabled.

### 4. Run

```bash
pm2 start scanner.cjs  --name parabolic-scanner
pm2 start server.cjs   --name parabolic-scanner-ui
pm2 save
```

| process | file | job |
|---|---|---|
| `parabolic-scanner` | `scanner.cjs` | polls Gate, grades coins, tracks outcomes, sends alerts |
| `parabolic-scanner-ui` | `server.cjs` | serves the dashboard and the JSON API on 8802 |

```bash
pm2 logs parabolic-scanner       # watch the brain work
pm2 restart parabolic-scanner    # restart the brain — does not touch the web page
```

### 5. Open it

```
http://localhost:8802/            the mobile dashboard
http://localhost:8802/api/scan   everything the dashboard renders, as JSON
```

Tuning is all environment variables with sane defaults: `POLL_MS` (30000),
`REFRESH_MS` (300000), `UNIVERSE` (150), `SPACING_MS` (120), `TRACK_HOURS` (24).

* * *

## 🧠 How a coin gets graded

Every 5 minutes each coin is re-graded into one of five tiers:

| tier | meaning | how often it fires |
|---|---|---|
| **PRIME** | strongest measured pattern | ~0.5% of hours |
| **IMMINENT** | strong combination | ~3% |
| **DANGER** | one strong signal | ~15% |
| **WARNING** | early or weak signal | ~30% |
| **QUIET** | nothing measured is present | the rest |

### The rules

`score.cjs` holds every rule. Tiers come from **combinations measured jointly** —
never from multiplying separate lifts together, because `oiChg24` and `ret24` are
correlated and treating them as independent would manufacture confidence that was
never measured.

```
PRIME      pump + RSI + volume + funding + OI stack        11.41x / 9.67x

IMMINENT   OI +30% and 10%+ off the high                    8.81x / 8.36x
           liquidations firing into a +20% 24h run          8.76x / 7.62x
           heavy liquidations, already off the high         8.38x / 7.05x

DANGER     up more than 20% in 24h                          8.96x / 6.43x
           open interest up more than 30% in 24h            7.64x / 6.15x
           liquidation volume above 1% of open interest     5.98x / 6.28x
           more than 20% below the 7d high                  6.63x / 5.80x
           violent 4h move                                  5.94x / 5.48x

WARNING    open interest moving fast (6h)                   3.94x / 3.54x
           liquidations elevated                            4.10x / 3.97x
           open interest unwinding hard (24h)               2.58x / 3.06x
           RSI stretched                                    2.77x / 2.32x
           volume surge above 4x                            2.58x / 2.10x
           shorts being squeezed                            2.04x / 1.42x
```

Numbers are train / test lift versus the base rate. "8.36x" means a coin matching
that rule fell 10%+ within 12h **8.36 times more often** than a random coin.

### Dampeners

Conditions measured *below* the base rate — evidence **against** a dump. They
knock the tier down one step, once, no matter how many fire:

```
sitting at its 7d high, OI quiet          0.37x / 0.27x
flat 24h and flat OI                      0.25x / 0.25x
no liquidations at all this hour          0.27x / 0.14x
```

### The score

`0–100`, for **ranking within a tier only**. Not a probability. Driven by the
strongest rule that fired plus a small bonus per corroborating rule — summing the
lifts saturates the cap instantly and double-counts correlated features.

### Hysteresis

A new tier must hold for **3 consecutive polls (90 seconds)** before it commits.
Without this, a coin sitting exactly on a threshold crossed it every poll — one
coin went `DANGER → PRIME → DANGER → PRIME` inside 90 seconds, firing an alert
each time and churning any downstream consumer.

### The two findings that shape everything

1. **Open interest is the signal, in EITHER direction.** A parabola still
   building and one violently unwinding both precede dumps. Quiet OI
   (−5%..+5% over 6h) sits at **0.5x** — half the base rate.
2. **Taker ratio is ANTI-predictive at the extremes.** Confirmed independently on
   Gate and Binance. Gate `lsr_taker < 0.85` → **0.68x**. Only the neutral
   0.95–1.05 band is elevated. Taker is displayed but **never scored as bearish**.

> An earlier auto-trader's Short Rule V2 (`taker < 0.95 && oi1h > 0 && funding <
> 0.05`) fired into a **3.25% dump rate against a 3.98% base = 0.82x** — worse
> than random. That is the whole explanation for its 20% win rate. **Do not "fix"
> this back.**

* * *

## 🛰️ Where the data comes from

**All market data is Gate.io.** One exception: Binance's 24h volume list, fetched
once an hour, used *only* to decide which coins are worth scanning. Every graded
number is Gate's.

`contract_stats` is why Gate and not Binance — one call returns open interest,
taker ratio, top-trader positioning **and liquidation volume**. Binance needs
three endpoints for a subset of that and publishes no liquidation history at all.
Liquidation share of open interest was the most train / test-stable signal found
(`5.98x / 6.28x`).

Nine calls per coin per refresh, all in parallel:

```
klines 1h · klines 15m · klines 5m · klines 1m
contract_stats 1h · 4h · 15m · 5m · 1m
```

4h is derived from the 1h series rather than fetched — free, and it can never
disagree with the data the tiers are computed from.

### Picking the 150

Ranked by each coin's **best position on either Gate or Binance**, not by the
larger raw volume. Volume-max lets the bigger exchange dominate: it filled the
list with Binance majors and pushed Gate-only tokens like EDGEX (Gate #113, not on
Binance) straight out. Comparing *positions* is symmetric. Current split is ~73 in
via Gate, ~77 via Binance, 9 Gate-only coins kept.

Gate lists 427 tokenized stocks and commodities among its 980 perps (XAU gold,
SNDK, CL crude, QQQX, SOXL). They are filtered out with Gate's own
`contract_type` field.

> **Do not filter by intersecting Binance's perp list.** That was tried and was
> wrong twice: Binance prefixes small-unit contracts (`1000PEPE`, `1000SHIB` — 15
> of them) so those coins never matched and were silently dropped; and "not on
> Binance" is not "not crypto", so Gate-only tokens were excluded too.

* * *

## 🔬 Where the rules came from

30 days of Gate 1h bars · 36,029 observations · 39 crypto perps · outcome = "did
price fall 10% within 12h" · base rate 6.0%. Symbols split odd / even into train
and test, **each half scored against its own base rate**.

```bash
node dump-study-gate.cjs --symbols=40   # Gate, incl. liquidations
node dump-study.cjs --symbols=40        # Binance, for comparison
node exit-study.cjs                     # when is the dump over
node patience-study.cjs                 # are we quitting too early
```

### PRIME is ported from tamad-scanner

TAMAD's parabolic scan measured **sharper than anything derived here** — its top
band hit 71% (Binance) / 76% (Gate) where the best IMMINENT rule hits 40%. It buys
that with a hard `change24h >= 30%` gate, so it is structurally blind to any setup
where OI is exploding but price has not pumped yet.

Three of its components measured **backwards on its own data** and are corrected:

| component | as written | measured |
|---|---|---|
| `taker < 1.0` | +30, its largest term | 37.1% vs 44.8% — deleted |
| within 5% of high | +5 | 31.2% vs 51.0% for 10%+ *below* — inverted |
| OI falling only | +15, rising got 0 | rising >30% is 6.15x vs 3.06x — both directions now |

Corrected, it went `71.1% → 76.1%` **while firing more often**.

> A second candidate — `ret24 >= 30` with price 10%+ off its high — looked like
> the best rule found on Binance (9.61x) and **did not replicate on Gate** (7.65x,
> below the IMMINENT rule beneath it). Deliberately absent. Do not add it back on
> the Binance number.

* * *

## 🚪 Exits, and the leverage problem

`exit-study.cjs` over 30 PRIME episodes. Median best available move **−16.9%**,
median time to the low **16h**.

| exit rule | fired | median P&L | capture |
|---|---|---|---|
| **fixed −15%** | 19/30 | **+9.7%** | **38%** |
| fixed −10% | 22/30 | +7.8% | 33% |
| time: 24h | 30/30 | +6.4% | 36% |
| longs liquidated (skew>2) | 30/30 | +3.9% | 33% |
| hold 48h | 0/30 | +4.1% | 26% |
| trail 5% off the low | 30/30 | −0.8% | −2% |
| liq spike >0.5% of OI | 28/30 | −1.5% | −9% |

**A fixed target beats every "smart" capitulation signal.** Trailing stops are
actively bad — these coins bounce 5% constantly and the trail whipsaws out.

### Leverage outranks the exit question

First touch, target −10%, stop at the liquidation price:

| leverage | liq at | target first | liquidated first |
|---|---|---|---|
| 3x | +31.7% | 20 (67%) | 9 (30%) |
| 5x | +19.0% | 19 (63%) | 10 (33%) |
| **10x** | **+9.5%** | 13 (43%) | **17 (57%)** |
| 20x | +4.8% | 6 (20%) | 24 (80%) |

**At 10x, 57% of signals liquidate before the dump arrives.** The 78% episode
dump rate is real — but a 10x short only survives ±9.5%, and 7 of 30 episodes rose
more than 50% against the position first. One (BTR) rose **+342%**.

### Being more patient (`patience-study.cjs`)

| stop | wins/losses | per trade |
|---|---|---|
| +8% | 6 / 23 | −$1.70 |
| +12% | 14 / 14 | +$0.53 |
| **+15%** | **16 / 12** | **+$0.83** |
| +18% | 16 / 11 | +$0.34 |

Moving the stop to breakeven produced **0 wins out of 30**. These coins bounce
back through entry after a 3% fall almost every time, so it cashes out every
winner before the real move. **Do not re-add this.**

> **The open question.** Going LONG on these signals made money. The up-move is
> BIGGER than the down-move (median peak **+26.3%** vs low **−16.9%**), and 16 of
> 30 signals peaked above +20%. Peak-before-trough is 50/50 across the backtest,
> so this is regime-dependent and unresolved. Not acted on.

* * *

## 📊 Live outcome tracking

Every rule rests on 30 backtest episodes. That is too small. `outcomes.cjs`
records what actually happens after each PRIME / IMMINENT signal on the live
150-coin universe, so the answers eventually come from measurement.

A record opens when a coin **enters** a tracked tier from below, follows price
every poll, and closes on target (−15%), stop (+15%) or 48h timeout. Closed
records append to `data/outcomes.jsonl` and are never rewritten.

**Limits, so the numbers are not over-read:**

- The path is sampled at the **poll interval (~30s)**, not tick by tick. A wick between two polls is invisible, biasing the record slightly towards *not* hitting levels.
- Prices are Gate `last`, so this measures **the signal, not a fill**. Real execution pays spread and slippage on top.
- **Stop is checked before target.** When one poll shows both breached the order is unknowable, and assuming the good one is how a backtest invents money.
- Records adopted mid-signal (after a restart) are flagged `seeded` — entry price and time are accurate but `maxFavPct` only accumulates from adoption.
- Every record stamps the `stopPct` it ran under, so a mid-flight rule change never blends two populations into one average.

* * *

## 🔔 Discord alerts

Configured in `data/webhooks.json` (`chmod 600`, never committed):

```json
{
  "enabled": true,
  "tiers": ["PRIME"],
  "urls": ["https://discord.com/api/webhooks/..."],
  "format": "card",
  "template": "fc {base} 1h % oi funding liq"
}
```

`format: "card"` sends a rich embed with the price moves across five timeframes,
open interest, liquidations, positioning, momentum, who is in control, the short
levels, this coin's own track record, and the reasons it fired — each with its
measured lift.

`format: "text"` sends one plain line built from `template`. Placeholders:
`{base} {price} {tier} {ret1h} {ret4h} {ret24h} {oiChg24} {oiChg6} {oi} {funding}
{liq} {liqSkew} {rsi} {vol} {offHigh} {score} {stack} {entry} {target} {stop}`.

**Anti-spam, two layers:** the 3-poll hysteresis above, plus a **one-hour
cooldown per coin**. Before both, one coin produced 5 alerts in an hour by
flapping across a threshold.

Test without waiting for a real signal:

```bash
curl http://localhost:8802/api/webhook-test
```

* * *

## 🧩 API

Served by `server.cjs` on port **8802**. All responses gzipped and `no-store`.

| endpoint | returns |
|---|---|
| `GET /` | the mobile dashboard |
| `GET /api/scan?tf=h1` | everything the dashboard renders. `tf` is `m1`/`m5`/`m15`/`h1`/`h4` and trims the payload to that timeframe — all five is 294KB gzipped, one is ~105KB |
| `GET /api/outcomes` | the full closed-signal log plus a summary |
| `GET /api/bars?symbol=X` | the scanner's own recorded 5-minute OHLC |
| `GET /api/pairlist` | the current universe in `RemotePairList` JSON format. `?tier=PRIME,IMMINENT` narrows it |
| `GET /api/webhook-test` | fires a sample alert to the configured webhook |

The scanner is the source of truth. Anything reading this API **re-derives
nothing** — if the logic needs to change, it changes in `score.cjs` where the
measurements live.

* * *

## 🔒 Security

The scanner holds **no exchange or trading credentials** — every Gate and Binance
call is a public, unauthenticated market-data endpoint. The only secret is the
Discord webhook URL, and `data/webhooks.json` is `chmod 600`, root-owned, and
gitignored. That part is fine.

The HTTP surface is not:

- **No authentication of any kind** on port 8802. No token, no basic-auth, no allowlist.
- `server.cjs` binds **all interfaces** (`0.0.0.0` + `::`). Public exposure is blocked only by the host firewall; there is no second layer. Bind to a specific address instead: `server.listen(PORT, '127.0.0.1')` or the tailnet IP.
- On a Tailscale host, the tailnet `iptables` chain accepts everything on `tailscale0` — so **every device on the tailnet can hit 8802 unauthenticated.**
- `Access-Control-Allow-Origin: *` on every response — any web page open in a browser on a reachable machine can script-read the API. The dashboard is same-origin and does not need this header.
- `GET /api/webhook-test` is unauthenticated **and side-effecting** — anyone who can reach the server can make it POST a Discord alert on demand. Its "not configured" branch also echoes `config` including the webhook URL. Require a secret on this endpoint, or remove it.
- `GET /api/bars` builds a path from the `symbol` param with only a `.jsonl` suffix and an existence check. Whitelist it: `if (!/^[A-Z0-9]+_USDT$/.test(sym)) return 400`.
- No rate limiting; `/api/scan` re-reads and gzips a ~3 MB `state.json` per request.

Minimum fix: add a shared-secret header check to the whole server, drop the
wildcard CORS header, bind to a single address, and lock `/api/webhook-test`.

* * *

## 🗂️ Project structure

```
scanner.cjs        poll loop, tiers, tracking, hysteresis, bar recording
gate.cjs           the only market-data layer
score.cjs          features, tier rules, dampeners — all citations live here
indicators.cjs     ATR / ADX / RSI / realised vol, Wilder-smoothed
outcomes.cjs       live outcome tracking
notify.cjs         Discord alerts, templates, anti-spam
chart.cjs          the candlestick PNG attached to alerts
server.cjs         API + dashboard on 8802
dashboard.html     the mobile UI
dump-study.cjs / dump-study-gate.cjs   the entry studies
exit-study.cjs                          exit rules and capture
patience-study.cjs                      stop width, breakeven, wait-to-enter
```

```
data/state.json        current candidates, tracked coins, open outcomes
data/outcomes.jsonl    every resolved signal, append-only, never rewritten
data/events.jsonl      tier changes, errors, webhook sends
data/webhooks.json     Discord config  (chmod 600)
data/bars/             the scanner's own 5-minute price record
data/ticks/            per-coin per-poll snapshots
```

* * *

## ⚠️ Gotchas that already bit

- **Liquidations accumulate within a bar.** The newest `contract_stats` row is the bar still forming and reads ~0 for most of its life. Features use the last *closed* bar. Reading the newest silently disabled two of the three IMMINENT rules.
- **Sanitised cache keys collide.** `key.replace(/[^a-z0-9._-]/gi,'_')` maps Gate's CJK meme perps (`牛来`, `龙虾`) to the same filename, so one silently read the other's data. Keys are hash-suffixed now.
- **Score each half against its own base rate.** Both studies once divided by the *pooled* base. The halves differed 2.0x (Binance) and 1.6x (Gate), so every published lift was wrong.
- **Check what is in the universe.** Gate's top perps by volume include tokenised equities and commodities. ~40% of the first Gate study universe was not crypto.
- **`target="_blank"` does nothing in phone standalone mode.** Dashboard chart links have to be opened from JS with a same-tab fallback.

### Two ideas tested and rejected — do not re-propose

- **Stop distance in ATRs.** 50% / 50% / 44% / 50% across buckets. Flat.
- **Signal crowding.** Quiet 48% vs crowded 78%, but buckets run 58 → 40 → 80 → 75 and n=9 in the crowded one. Noise wearing a pattern.

* * *

## 📝 The honest summary

This is a good **detector** and not yet a validated **trade**.

PRIME reaches −10% in 78% of backtest episodes, which is real. But at 10x
leverage most positions liquidate before that happens, only one configuration out
of ~60 tested came out profitable (+$0.83/trade on 30 episodes — the shape of an
overfit result), and going *long* on the same signals scored marginally better.

Half the signalling coins trade under $2M/day on Gate and cannot be sized into.

The live tracker is the thing that will eventually settle this. Re-run the
studies as episodes accumulate.

* * *

## 💜 Donate

If this saved you a bad short, a tip is appreciated.

☕ **Buy Me a Coffee:** https://www.buymeacoffee.com/comvibewithmir

| token | network | address |
|---|---|---|
| **USDT** | **BNB Smart Chain (BEP20)** | `0x2f74e92620dbf20be51c7530bd96dd0a274c7d77` |

> ⚠️ **BEP20 only.** Sending on any other network (ERC20, TRC20, …) will lose the
> funds. Minimum 0.001 USDT.

* * *

## 📄 License & disclaimer

ISC. See `package.json`.

**Not financial advice.** This software produces statistical signals from public
market data for research and monitoring. It does not place orders. Trading
leveraged perpetuals can lose more than your deposit. Every number here is
measured on a small sample and may not hold out of sample. You are responsible
for anything you do with a signal.
