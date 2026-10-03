#!/usr/bin/env node
// screener.js — Meteora DLMM pool screener -> Slack
//
// Every LOOP_MIN minutes: pulls SOL-paired DLMM pools from Meteora's datapi, applies your filters,
// ranks survivors into tiers, saves a snapshot (so LP-flow / TVL trends can be computed), and:
//   - posts a full ranked digest to Slack every DIGEST_HOURS
//   - posts an instant alert when a pool NEWLY enters CORE or HOT
//
// Settings live in screener_settings.json (same folder). Start with:  pm2 start screener.config.js
// One-off test without Slack:  node screener.js --once --print
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = process.env.BOT_DATA_DIR || __dirname;   // botplatform patch: per-instance data dir
const SETTINGS = path.join(DIR, "screener_settings.json");
const HIST = path.join(DIR, "screener_history.json");
const STATE = path.join(DIR, "screener_state.json");
const REPORT = path.join(DIR, "screener_report.txt");
const PICKS = path.join(DIR, "screener_picks.json");   // read by copylp v0.7.0 screener mode
const DATAPI = "https://dlmm.datapi.meteora.ag";
const SOL = "So11111111111111111111111111111111111111112";
const UA = { "User-Agent": "screener/1.0" };

const args = process.argv.slice(2);
const ONCE = args.includes("--once"), PRINT = args.includes("--print"), FORCE_DIGEST = args.includes("--digest");

const DEFAULTS = {
  SLACK_WEBHOOK_URL: "",
  LOOP_MIN: 60, DIGEST_HOURS: 4, DIGEST_TOP: 15,
  WALLETS: [],                                              // your copy wallets: pools you hold get flagged, and their exits alert first
  MIN_TVL_USD: 25000, MIN_VOL24_USD: 100000, MIN_MCAP_USD: 1000000, MIN_HOLDERS: 1000, MIN_POOL_AGE_H: 24,
  PACE_MIN: 4, PACE_CORE_MAX: 12, PACE_HOT_MAX: 25,        // %/day on the 4h window, paced to 24h
  MOMENTUM_CORE: 0.8, MOMENTUM_WATCH: 0.4,                  // 4h pace / MOMENTUM_BASE pace
  MOMENTUM_BASE: "12h",                                     // compare 4h against this window (12h: a settled pool isn't punished for a spike ~20h ago)
  TVL_EXODUS_PCT: 40,                                       // TVL down more than this over ~24h = LPs leaving
  PACE_FLOOR: 2,                                            // pace4h under this = immediate EXIT (real collapse)
  EXIT_PACE: 3,                                             // held pools only EXIT for slowness below this (after EXIT_CONFIRM scans);
                                                            // between EXIT_PACE and PACE_MIN they sit in WATCH (no new money, no exit)
  EXIT_CONFIRM: 3,                                          // slow / fading must persist this many hourly scans before EXIT (WATCH meanwhile)
  RPC_URL: "https://api.mainnet-beta.solana.com",           // for transfer-tax lookup; a Helius URL is better
  MAX_TAX_BPS: 100,                                         // tokens taxed above this (bps; 100 = 1%) are dropped from the digest,
                                                            // alerts and picks — unless one of your WALLETS holds the pool
  IGNORED_MINTS: [],
  // CORE+ = most stable CORE pools, 2X size suggested. A pool must meet ALL of these:
  PLUS_PACE_MIN: 4, PLUS_PACE_MAX: 10,                      // 4h, 12h and 24h pace all inside this band (%/day)
  PLUS_RATIO_MIN: 0.7, PLUS_RATIO_MAX: 1.5,                 // pace4h / pace24h (level, not a spike)
  PLUS_MOM_MIN: 0.8, PLUS_MOM_MAX: 1.5,                     // momentum band
  PLUS_TVL_CHG_MIN: -10, PLUS_TVL_CHG_MAX: 25,              // TVL change %, needs 12h+ of our own history
  PLUS_STREAK: 6,                                           // consecutive CORE passes (hourly = 6h)
  PLUS_MIN_MCAP_USD: 10000000, PLUS_MIN_TVL_USD: 150000,
  AGED_TOKEN_DAYS: 7,                                       // tokens at least this old (oldest Meteora pool) get the looser pace lines below (0 = off)
  PACE_MIN_AGED: 2, EXIT_PACE_AGED: 1.5, PACE_FLOOR_AGED: 1,  // aged-token versions of PACE_MIN / EXIT_PACE / PACE_FLOOR
  PLUS_SIZE_MULT: 2,                                        // suggested size vs normal CORE (published in picks as sizeMult)                                        // token mints to drop completely: no digest, no alerts, not in picks (so the bot never sees them)
};
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch {}
  const out = { ...DEFAULTS, ...s };
  const ig = out.IGNORED_MINTS;
  out.IGNORED = new Set((Array.isArray(ig) ? ig : String(ig || "").split(",")).map(x => String(x).trim()).filter(Boolean));
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (a === 3) throw e; await sleep(1500 * (a + 1)); }
  }
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
// Windows-safe write: temp file + rename, 3 retries. Never throws — a locked/blocked file is logged
// and skipped so it can't kill the whole pass (the v1 EPERM on screener_history.json stopped
// picks + Slack for 12h). Returns true on success.
function safeWrite(file, text) {
  for (let a = 1; a <= 3; a++) {
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, text);
      try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
      return true;
    } catch (e) {
      if (a === 3) { console.error(`write failed (${path.basename(file)}): ${e.code || e.message}`); return false; }
      const until = Date.now() + 400 * a; while (Date.now() < until) {}   // brief sync backoff
    }
  }
  return false;
}

// ---------- transfer tax (Token-2022 transfer fee), cached forever per mint ----------
async function taxBps(mints, S, cache) {
  const need = mints.filter(m => !(m in cache));
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    try {
      const r = await fetch(S.RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [batch, { encoding: "jsonParsed" }] }) });
      const j = await r.json();
      (j.result?.value || []).forEach((acc, k) => {
        let bps = 0;
        for (const e of acc?.data?.parsed?.info?.extensions || [])
          if (e.extension === "transferFeeConfig") bps = e.state?.newerTransferFee?.transferFeeBasisPoints || 0;
        cache[batch[k]] = bps;
      });
    } catch {}
    await sleep(400);
  }
  return cache;
}

// ---------- one pass ----------
async function pass() {
  const S = loadSettings();
  const now = Math.floor(Date.now() / 1000);

  // 1) pull pools by 24h volume until below the volume floor
  const pools = [];
  for (let page = 1; page <= 20; page++) {
    const j = await get(`${DATAPI}/pools?page=${page}&page_size=100&sort_by=volume_24h:desc`);
    const d = j.data || [];
    pools.push(...d);
    if (!d.length || (d[d.length - 1].volume?.["24h"] || 0) < S.MIN_VOL24_USD) break;
    await sleep(250);
  }

  // 2) hard filters
  const hist = readJson(HIST, {});
  const cand = [];
  let blocked = 0;
  for (const p of pools) {
    if (p.token_y?.address !== SOL || p.is_blacklisted) continue;
    if (S.IGNORED.has(p.token_x?.address)) { blocked++; continue; }   // your manual blocklist
    const tvl = p.tvl || 0, v24 = p.volume?.["24h"] || 0, mcap = p.token_x?.market_cap || 0;
    const ageH = (Date.now() - (p.created_at || 0)) / 3600e3;
    if (tvl < S.MIN_TVL_USD || v24 < S.MIN_VOL24_USD || mcap < S.MIN_MCAP_USD) continue;
    if ((p.token_x?.holders || 0) < S.MIN_HOLDERS || ageH < S.MIN_POOL_AGE_H) continue;
    const pace24 = p.fee_tvl_ratio?.["24h"] || 0;          // already %/day
    const pace4 = (p.fee_tvl_ratio?.["4h"] || 0) * 6;       // 4h paced to 24h
    const baseH = { "12h": 12, "24h": 24 }[S.MOMENTUM_BASE] || 12;
    const paceBase = (p.fee_tvl_ratio?.[S.MOMENTUM_BASE] ?? p.fee_tvl_ratio?.["12h"] ?? 0) * (24 / baseH);
    const pace12 = (p.fee_tvl_ratio?.["12h"] || 0) * 2;
    const mom = paceBase > 0 ? pace4 / paceBase : 0;
    // TVL trend from our own snapshots (~24h back, else oldest available)
    const h = hist[p.address] || [];
    const past = h.filter(x => x[0] <= now - 20 * 3600).pop() || h[0];
    const tvlChg = past && past[1] > 0 ? (tvl / past[1] - 1) * 100 : null;
    const trackedH = past ? (now - past[0]) / 3600 : 0;
    cand.push({ p, tvl, v24, mcap, pace24, pace12, pace4, mom, tvlChg, trackedH,
      step: p.pool_config?.bin_step, fee: p.pool_config?.base_fee_pct, sym: p.token_x?.symbol || "?", mint: p.token_x?.address });
  }

  // 2b) pools you currently hold (so exits on YOUR pools are called out)
  const held = {};
  for (const w of S.WALLETS || []) {
    try {
      const j = await get(`${DATAPI}/portfolio/open?user=${w}&page=1&page_size=100`);
      for (const q of j.pools || []) held[q.poolAddress] = true;
    } catch {}
    await sleep(200);
  }

  // 3) transfer tax for candidates
  const state = readJson(STATE, { tax: {}, tiers: {}, lastDigest: 0 });
  await taxBps([...new Set(cand.map(c => c.mint))], S, state.tax);

  // 3b) token age = age of the token's OLDEST Meteora pool (any quote). Looked up once per mint and cached:
  //     the oldest pool's creation time never changes, so age just grows from there.
  state.tokenBorn = state.tokenBorn || {};
  if (S.AGED_TOKEN_DAYS > 0) {
    for (const mint of new Set(cand.map(c => c.mint))) {
      if (state.tokenBorn[mint]) continue;
      try {
        const j = await get(`${DATAPI}/pools?query=${mint}&page_size=50`);
        const ts = (j.data || []).filter(q => q.token_x?.address === mint || q.token_y?.address === mint).map(q => q.created_at || 0).filter(Boolean);
        if (ts.length) state.tokenBorn[mint] = Math.min(...ts);
      } catch {}
      await sleep(250);
    }
  }
  for (const c of cand) {
    const born = Math.min(state.tokenBorn[c.mint] || Infinity, c.p.created_at || Infinity);
    c.tokenAgeD = Number.isFinite(born) ? (Date.now() - born) / 86400e3 : 0;
    c.aged = S.AGED_TOKEN_DAYS > 0 && c.tokenAgeD >= S.AGED_TOKEN_DAYS;
  }

  // 4) tiering — with exit confirmation (v3): a pool that was already in (CORE/HOT/WATCH) and turns
  //    slow or fading goes to WATCH first and only EXITs after EXIT_CONFIRM consecutive bad scans.
  //    Exceptions that act immediately: pace4h < PACE_FLOOR (collapse), LPs leaving.
  const prevPicks = readJson(PICKS, { pools: {} }).pools || {};
  for (const c of cand) {
    c.tax = state.tax[c.mint] || 0;
    const pv = prevPicks[c.p.address] || {};
    const wasIn = pv.tier === "CORE" || pv.tier === "HOT" || pv.tier === "WATCH";
    // aged tokens (>= AGED_TOKEN_DAYS) use the looser pace lines; never stricter than the normal ones
    const pMin = c.aged ? Math.min(S.PACE_MIN, S.PACE_MIN_AGED) : S.PACE_MIN;
    const pExit = c.aged ? Math.min(S.EXIT_PACE, S.EXIT_PACE_AGED) : S.EXIT_PACE;
    const pFloor = c.aged ? Math.min(S.PACE_FLOOR, S.PACE_FLOOR_AGED) : S.PACE_FLOOR;
    c.slowN = c.pace4 < pExit ? (pv.slowN || 0) + 1 : 0;
    c.fadeN = c.mom < S.MOMENTUM_WATCH ? (pv.fadeN || 0) + 1 : 0;
    c.pending = "";
    const exodus = c.tvlChg != null && c.trackedH >= 6 && c.tvlChg < -S.TVL_EXODUS_PCT;
    if (exodus) c.tier = "SKIP-LPs leaving";
    else if (c.pace4 < pFloor) c.tier = "SKIP-too slow";
    else if (c.pace4 < pExit) {                      // below the exit line: count toward EXIT
      if (wasIn && c.slowN < S.EXIT_CONFIRM) { c.tier = "WATCH"; c.pending = `slow ${c.slowN}/${S.EXIT_CONFIRM}`; }
      else c.tier = "SKIP-too slow";
    }
    else if (c.pace4 < pMin) {                             // between exit line and entry line: hold if already in, never enter new
      if (wasIn) { c.tier = "WATCH"; c.pending = `below ${pMin}%, holding`; }
      else c.tier = "SKIP-too slow";
    }
    else if (c.pace4 > S.PACE_HOT_MAX) c.tier = "SKIP-frenzy";
    else if (c.mom < S.MOMENTUM_WATCH) {
      if (wasIn && c.fadeN < S.EXIT_CONFIRM) { c.tier = "WATCH"; c.pending = `fading ${c.fadeN}/${S.EXIT_CONFIRM}`; }
      else c.tier = "SKIP-fading";
    }
    else if (c.pace4 > S.PACE_CORE_MAX) c.tier = "HOT";
    else if (c.mom >= S.MOMENTUM_CORE) c.tier = "CORE";
    else c.tier = "WATCH";
    // shape + range per your rules
    if (c.tier === "HOT" || c.step >= 100) c.shape = `BidAsk ${c.step >= 200 ? "70-80" : "60-80"}% deep${c.tier === "HOT" ? ", HALF size" : ""}`;
    else c.shape = "Spot 75-100% or BidAsk 60-80%";
    c.score = Math.min(c.pace4, S.PACE_CORE_MAX) * Math.min(c.mom, 1.5) * Math.log10(c.tvl / S.MIN_TVL_USD + 1);
    // CORE+ : consecutive CORE passes (seeded from the old streak on first run of this version)
    const pvCore = pv.coreStreak ?? (pv.tier === "CORE" ? pv.streak || 0 : 0);
    c.coreStreak = c.tier === "CORE" ? pvCore + 1 : 0;
    const inBand = v => v >= S.PLUS_PACE_MIN && v <= S.PLUS_PACE_MAX;
    const ratio = c.pace24 > 0 ? c.pace4 / c.pace24 : 0;
    c.plus = c.tier === "CORE"
      && inBand(c.pace4) && inBand(c.pace12) && inBand(c.pace24)
      && ratio >= S.PLUS_RATIO_MIN && ratio <= S.PLUS_RATIO_MAX
      && c.mom >= S.PLUS_MOM_MIN && c.mom <= S.PLUS_MOM_MAX
      && c.tvlChg != null && c.trackedH >= 12 && c.tvlChg >= S.PLUS_TVL_CHG_MIN && c.tvlChg <= S.PLUS_TVL_CHG_MAX
      && c.coreStreak >= S.PLUS_STREAK
      && !c.tax && c.mcap >= S.PLUS_MIN_MCAP_USD && c.tvl >= S.PLUS_MIN_TVL_USD;
    if (c.plus) c.shape += `   ** CORE+ : ${S.PLUS_SIZE_MULT}X size suggested **`;
  }
  // taxed tokens above MAX_TAX_BPS: out of the digest / alerts / picks unless you hold the pool
  for (const c of cand) if (c.tax > S.MAX_TAX_BPS && !(c.p.address in held)) { c.tier = "SKIP-taxed"; c.plus = false; }
  const order = { CORE: 0, HOT: 1, WATCH: 2 };
  const ranked = cand.filter(c => c.tier in order).sort((a, b) => order[a.tier] - order[b.tier] || (b.plus - a.plus) || b.score - a.score);

  // 5) save snapshot (keep 7 days)
  for (const c of cand) {
    const h = (hist[c.p.address] = hist[c.p.address] || []);
    h.push([now, Math.round(c.tvl), +c.pace4.toFixed(2), +c.pace24.toFixed(2), Math.round(c.v24)]);
  }
  for (const k of Object.keys(hist)) {
    hist[k] = hist[k].filter(x => x[0] >= now - 7 * 86400);
    if (!hist[k].length) delete hist[k];
  }
  const histOk = safeWrite(HIST, JSON.stringify(hist));

  // 5b) publish picks for the trading bot: tier + consecutive-pass streak, and a "gone" counter
  //     for pools that dropped out of the filters (bot exits after 2 gone passes)
  {
    const prev = prevPicks;
    const goodT = t => t === "CORE" || t === "HOT";
    const out = {};
    for (const c of cand) {
      const pv = prev[c.p.address];
      out[c.p.address] = { tier: c.tier, sym: c.sym, mint: c.mint, step: c.step,
        pace4: +c.pace4.toFixed(2), mom: +c.mom.toFixed(2), score: +c.score.toFixed(3), slowN: c.slowN, fadeN: c.fadeN,
        streak: goodT(c.tier) ? ((pv && goodT(pv.tier) ? pv.streak || 1 : 0) + 1) : 0,
        coreStreak: c.coreStreak, plus: !!c.plus, sizeMult: c.plus ? S.PLUS_SIZE_MULT : 1,
        aged: !!c.aged, tokenAgeD: +c.tokenAgeD.toFixed(1),
        lowPace: !!(c.aged && c.pace4 < S.PACE_MIN) };           // aged pool listed only thanks to the lower line (bot sizes these down)
    }
    for (const [addr, pv] of Object.entries(prev)) {
      if (out[addr]) continue;
      if (S.IGNORED.has(pv.mint)) continue;                  // blocked: dropped from picks entirely
      const gone = (pv.tier === "GONE" ? pv.gone || 1 : 0) + 1;
      if (gone <= 24) out[addr] = { ...pv, tier: "GONE", gone, streak: 0 };
    }
    if (!safeWrite(PICKS, JSON.stringify({ ts: now, pools: out }))) console.error("PICKS NOT WRITTEN — trading bot will pause after 90 min");
  }

  // 6) format
  const $k = v => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`;
  const line = (c, i) =>
    `${String(i + 1).padStart(2)}. ${((c.plus ? "CORE+" : c.tier) + (c.pending ? `(${c.pending})` : "")).padEnd(5)} ${c.sym.slice(0, 10).padEnd(11)}${(c.fee + "%/" + c.step).padEnd(9)}` +
    `pace4h ${c.pace4.toFixed(1).padStart(5)}%  12h ${c.pace12.toFixed(1).padStart(5)}%  24h ${c.pace24.toFixed(1).padStart(5)}%  mom ${c.mom.toFixed(2)}  ` +
    `TVL ${$k(c.tvl).padStart(6)}${c.tvlChg == null || c.trackedH < 6 ? "" : ` (${c.tvlChg >= 0 ? "+" : ""}${c.tvlChg.toFixed(0)}%/${Math.round(c.trackedH)}h)`}  ` +
    `vol ${$k(c.v24)}  mcap ${$k(c.mcap)}${c.tax ? `  TAX ${(c.tax / 100).toFixed(1)}%` : ""}${c.p.address in held ? "  [YOU HOLD]" : ""}\n` +
    `      -> ${c.shape}   https://app.meteora.ag/dlmm/${c.p.address}`;
  const skipped = {};
  for (const c of cand) if (c.tier.startsWith("SKIP")) skipped[c.tier] = (skipped[c.tier] || 0) + 1;
  const stamp = new Date(now * 1000).toISOString().slice(0, 16).replace("T", " ");
  const digest =
    `*Meteora screener* - ${stamp} UTC - ${pools.length} pools scanned, ${cand.length} passed filters, ${ranked.length} ranked\n` +
    "```\n" + (ranked.slice(0, S.DIGEST_TOP).map(line).join("\n") || "nothing passes right now") + "\n```\n" +
    `Skipped: ${Object.entries(skipped).map(([k, v]) => `${k.replace("SKIP-", "")} ${v}`).join(", ") || "none"}` +
    `${blocked ? `, blocked by you ${blocked}` : ""}` +
    `${Object.keys(hist).length && ranked.some(c => c.trackedH < 6) ? "\n_LP-flow (TVL change) shows once a pool has 6h+ of history._" : ""}` +
    `${histOk ? "" : "\n:warning: _history file could not be saved this pass (file locked/permission) — LP-flow data is not accumulating._"}`;
  safeWrite(REPORT, digest.replace(/[*_`]/g, ""));
  if (PRINT) console.log(digest.replace(/[*_`]/g, ""));

  // 7) Slack: alerts for NEW entries into CORE/HOT, digest every DIGEST_HOURS
  const post = async text => {
    if (!S.SLACK_WEBHOOK_URL) return;
    try { await fetch(S.SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }); }
    catch (e) { console.error("slack post failed:", e.message); }
  };
  const good = t => t === "CORE" || t === "HOT";
  const firstRun = Object.keys(state.tiers).length === 0;
  const byAddr = Object.fromEntries(cand.map(c => [c.p.address, c]));
  // ENTER: pool newly in CORE/HOT
  const newly = ranked.filter(c => good(c.tier) && !good(state.tiers[c.p.address]));
  // CORE+ upgrades / downgrades (state.plus remembers last pass)
  const prevPlus = state.plus || {};
  const plusUp = ranked.filter(c => c.plus && !prevPlus[c.p.address]);
  const plusDown = cand.filter(c => !c.plus && prevPlus[c.p.address]);
  // EXIT: pool was CORE/HOT last pass and now isn't (WATCH, any SKIP reason, or fell out of the filters)
  const exits = [];
  for (const [addr, prev] of Object.entries(state.tiers)) {
    const c = byAddr[addr];
    if (!c && S.IGNORED.has((prevPicks[addr] || {}).mint)) continue;   // blocked by you, not a real exit
    if (c && c.tier === "SKIP-taxed") continue;                           // hidden by MAX_TAX_BPS, not a real exit
    const nowOut = !c || c.tier.startsWith("SKIP");
    const pvPending = (prevPicks[addr] || {}).slowN > 0 || (prevPicks[addr] || {}).fadeN > 0;
    if (!good(prev) && !(prev === "WATCH" && nowOut && ((addr in held) || pvPending))) continue;
    if (c && good(c.tier)) continue;
    const why = !c ? "failed filters (volume/TVL/mcap fell below minimums)"
      : c.tier === "WATCH" ? (c.pending ? `${c.pending} — EXIT if it persists` : `slowing: momentum ${c.mom.toFixed(2)}, pace4h ${c.pace4.toFixed(1)}%`)
      : c.tier.replace("SKIP-", "") + `: pace4h ${c.pace4.toFixed(1)}%, mom ${c.mom.toFixed(2)}` + (c.tvlChg != null && c.trackedH >= 6 ? `, TVL ${c.tvlChg.toFixed(0)}%` : "");
    exits.push({ addr, name: c ? c.sym : ((state.names || {})[addr] || addr.slice(0, 6)), prev,
                 to: c && c.tier === "WATCH" ? "WATCH" : "EXIT", why, mine: addr in held });
  }
  exits.sort((a, b) => (b.mine - a.mine) || (a.to === "EXIT" ? -1 : 1));
  if (!firstRun && exits.length) {
    const nMine = exits.filter(e => e.mine).length;
    const head = nMine ? `*:rotating_light: ${nMine} pool(s) YOU HOLD changed tier*` : "*Tier changes*";
    await post(head + "\n```\n" + exits.map(e =>
      `${e.mine ? "YOU HOLD " : "         "}${e.name.slice(0, 10).padEnd(11)}${e.prev} -> ${e.to}   ${e.why}\n         https://app.meteora.ag/dlmm/${e.addr}`).join("\n") + "\n```");
  }
  if (!firstRun && newly.length)
    await post("*New in CORE/HOT*\n```\n" + newly.map((c, k) => line(c, k)).join("\n") + "\n```");
  if (!firstRun && plusUp.length)
    await post(`*:star: Now CORE+ (most stable, ${S.PLUS_SIZE_MULT}X size suggested)*\n\`\`\`\n` + plusUp.map((c, k) => line(c, k)).join("\n") + "\n```");
  if (!firstRun && plusDown.length)
    await post("*Lost CORE+ (back to normal size)*\n```\n" + plusDown.map(c =>
      `${c.p.address in held ? "YOU HOLD " : "         "}${c.sym.slice(0, 10).padEnd(11)}now ${c.tier}   pace4h ${c.pace4.toFixed(1)}%  24h ${c.pace24.toFixed(1)}%  mom ${c.mom.toFixed(2)}` +
      `${c.tvlChg != null ? `  TVL ${c.tvlChg.toFixed(0)}%` : ""}\n         https://app.meteora.ag/dlmm/${c.p.address}`).join("\n") + "\n```");
  if (FORCE_DIGEST || firstRun || now - state.lastDigest >= S.DIGEST_HOURS * 3600 - 60) {
    await post(digest);
    state.lastDigest = now;
  }
  state.tiers = Object.fromEntries(cand.map(c => [c.p.address, c.tier]));
  state.plus = Object.fromEntries(cand.filter(c => c.plus).map(c => [c.p.address, 1]));
  state.names = { ...(state.names || {}), ...Object.fromEntries(cand.map(c => [c.p.address, c.sym])) };
  safeWrite(STATE, JSON.stringify(state));
  console.log(`${stamp}  scanned ${pools.length}, passed ${cand.length}, ranked ${ranked.length}, new CORE/HOT ${newly.length}, exits ${exits.length}, blocked ${blocked}, CORE+ ${cand.filter(c => c.plus).length}`);
}

(async () => {
  await pass().catch(e => console.error("pass failed:", e.message));
  if (ONCE) return;
  for (;;) {
    await sleep(loadSettings().LOOP_MIN * 60_000);
    await pass().catch(e => console.error("pass failed:", e.message));
  }
})();
