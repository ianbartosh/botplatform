"use strict";
// Position tracking + lever features.
// Every minute the tracker reads each LP instance's state file and keeps the positions table in
// step with it. The first time it sees a new position it snapshots the pool and token from Meteora
// and Jupiter — TVL, market cap, volume, token and pool age, fee pace over 30m/1h/4h/24h, bin step,
// base fee — together with the shape, range width and the instance's stop-loss settings at that
// moment. When the position closes it records the outcome (last and peak PnL, close reason).
// That gives one row per position with the levers on one side and the result on the other.
const fs = require("fs");
const path = require("path");
const { strategy, slConfig } = require("./strategies");

const DATAPI = "https://dlmm.datapi.meteora.ag";
const JUP = "https://lite-api.jup.ag";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) botplatform-tracker" };
const FEE_WIN_H = { "30m": 0.5, "1h": 1, "4h": 4, "24h": 24 };

const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v);
function widthPct(minBin, maxBin, step) {
  if (![minBin, maxBin, step].every(Number.isFinite)) return null;
  return +((Math.pow(1 + step / 10000, maxBin - minBin + 1) - 1) * 100).toFixed(2);
}
// fee/TVL over a window, extrapolated to a %/day pace (same formula as the bots and the screener)
function pace(p, win) {
  const fees = num(p?.fees?.[win]), tvl = num(p?.tvl);
  return fees !== null && tvl > 0 ? +((fees / tvl) * 100 * (24 / FEE_WIN_H[win])).toFixed(3) : null;
}

async function fetchPool(pool, fetchFn) {
  const r = await fetchFn(`${DATAPI}/pools?query=${pool}&page_size=5`, { headers: UA });
  const j = await r.json();
  return (j.data || []).find(x => x.address === pool) || null;
}
async function fetchTokenAgeH(mint, fetchFn, now) {
  try {
    const r = await fetchFn(`${JUP}/tokens/v2/search?query=${mint}`);
    const j = await r.json();
    const t = Array.isArray(j) ? j.find(x => x.id === mint) : null;
    const ts = t?.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : NaN;
    return Number.isFinite(ts) ? +((now - ts) / 3.6e6).toFixed(2) : null;
  } catch { return null; }
}

function targetEntry(settings, target) {
  if (!target) return null;
  return (settings.TARGET_WALLETS || "").split(",").map(s => s.trim()).find(s => s.split(":")[0] === target) || null;
}

class Tracker {
  constructor({ store, instanceDir, fetchFn = (...a) => fetch(...a), intervalMs = 60_000, log = () => {} }) {
    Object.assign(this, { store, instanceDir, fetchFn, intervalMs, log });
    this.timer = null;
    this.busy = false;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runOnce().catch(e => this.log(`[tracker] ${e.message}`)), this.intervalMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async runOnce(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const inst of this.store.listInstances()) {
        let s;
        try { s = strategy(inst.strategy); } catch { continue; }
        if (s.tracks !== "lp" || !s.stateFile) continue;
        await this.syncInstance(inst, path.join(this.instanceDir(inst.id), s.stateFile), now);
      }
    } finally { this.busy = false; }
  }

  async syncInstance(inst, stateFile, now) {
    let S;
    try { S = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return; }   // not started yet / mid-write
    const settings = this.store.getSettings(inst.id);
    const toCapture = [];
    for (const [pos, m] of Object.entries(S.mine || {})) {
      const prev = this.store.getPosition(inst.id, pos);
      const closed = !!m.closed;
      let reason = null;
      if (closed && !(prev && prev.close_reason)) {
        const line = this.store.lastCloseLine(inst.id, pos.slice(0, 8));
        const mm = line && line.match(/CLOSE \S+ \(([^)]*)\)/);
        reason = mm ? mm[1] : null;
      }
      this.store.upsertPosition({
        instance_id: inst.id, pos, pool: m.pool ?? null, mint: m.mint ?? null, symbol: m.scrSym ?? null,
        target: m.target ?? null, shape: m.shape ?? null, leg: m.leg ?? null, tier: m.scrTier ?? null,
        sol_in: num(m.solIn), min_bin: num(m.minBin), max_bin: num(m.maxBin), bin_step: num(m.step),
        width_pct: widthPct(+m.minBin, +m.maxBin, +m.step), opened_at: num(m.ts), first_seen: prev ? prev.first_seen : now,
        closed_at: closed ? (prev && prev.closed_at) || now : null,
        last_pnl_pct: num(m.lastPnl), peak_pnl_pct: num(m.peakPnl),
        status: closed ? "closed" : "open", close_reason: reason, ladder: m.ladderId ?? null,
      });
      if (!closed && m.pool && !this.store.hasFeatures(inst.id, pos)) toCapture.push([pos, m]);
    }
    // one pool lookup serves every chunk of a ladder
    const poolCache = new Map(), ageCache = new Map();
    for (const [pos, m] of toCapture) {
      try {
        if (!poolCache.has(m.pool)) poolCache.set(m.pool, await fetchPool(m.pool, this.fetchFn));
        const p = poolCache.get(m.pool);
        if (m.mint && !ageCache.has(m.mint)) ageCache.set(m.mint, await fetchTokenAgeH(m.mint, this.fetchFn, now));
        const sl = { ...slConfig(settings) };
        const te = targetEntry(settings, m.target);
        if (te) sl._target = te;
        if (m.scrTier) sl._tier = m.scrTier;
        this.store.insertFeatures({
          instance_id: inst.id, pos, captured_at: now,
          capture_lag_s: Number.isFinite(+m.ts) ? Math.max(0, (now - m.ts) / 1000) : null,
          tvl_usd: num(p?.tvl), mcap_usd: num(p?.token_x?.market_cap), volume_24h_usd: num(p?.volume?.["24h"]),
          token_age_h: m.mint ? ageCache.get(m.mint) : null,
          pool_age_h: num(p?.created_at) ? +((now - p.created_at) / 3.6e6).toFixed(2) : null,
          fee_pace_30m: pace(p, "30m"), fee_pace_1h: pace(p, "1h"), fee_pace_4h: pace(p, "4h"), fee_pace_24h: pace(p, "24h"),
          bin_step: num(p?.pool_config?.bin_step) ?? num(m.step), base_fee_pct: num(p?.pool_config?.base_fee_pct),
          shape: m.shape ?? null, width_pct: widthPct(+m.minBin, +m.maxBin, +m.step),
          sl_config: JSON.stringify(sl), raw: p ? JSON.stringify(p) : null,
        });
      } catch (e) { this.log(`[tracker] ${inst.id} ${pos.slice(0, 8)}: ${e.message}`); }
    }
  }
}

module.exports = { Tracker, widthPct, pace };
