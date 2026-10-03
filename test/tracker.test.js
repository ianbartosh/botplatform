"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpEnv } = require("./helpers");
const { Tracker, widthPct, pace } = require("../engine/tracker");

const POOL = "PooL1111111111111111111111111111111111111111";
const MINT = "MinT1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-10-03T12:00:00Z");

const poolJson = {
  address: POOL, tvl: 200000, created_at: NOW - 48 * 3.6e6,
  token_x: { address: MINT, market_cap: 5_000_000 }, token_y: { address: "So11111111111111111111111111111111111111112", price: 120 },
  pool_config: { bin_step: 80, base_fee_pct: 0.8 },
  volume: { "24h": 3_000_000 },
  fees: { "30m": 100, "1h": 250, "4h": 800, "24h": 4000 },
};
const fakeFetch = calls => async url => {
  calls.push(url);
  if (url.includes("datapi")) return { json: async () => ({ data: [poolJson] }) };
  if (url.includes("jup.ag")) return { json: async () => [{ id: MINT, firstPool: { createdAt: new Date(NOW - 72 * 3.6e6).toISOString() } }] };
  throw new Error("unexpected " + url);
};

test("widthPct and pace match the bots' formulas", () => {
  assert.equal(widthPct(0, 68, 100), +((1.01 ** 69 - 1) * 100).toFixed(2));
  assert.equal(pace(poolJson, "4h"), +((800 / 200000) * 100 * 6).toFixed(3));   // 2.4 %/day
  assert.equal(pace(poolJson, "1h"), 3);
  assert.equal(widthPct(NaN, 1, 1), null);
});

test("tracker records positions, captures entry levers once, and records the outcome", async t => {
  const E = tmpEnv(); t.after(E.cleanup);
  const idir = id => path.join(E.dir, "instances", id);
  E.store.addInstance("t", { id: "slp", strategy: "screenerlp" });
  E.store.setSetting("t", "slp", "STOP_LOSS_PCT", "18");
  E.store.setSetting("t", "slp", "TARGET_WALLETS", "SrcWaLLet:sl=off:hard=25");
  fs.mkdirSync(idir("slp"), { recursive: true });
  const state = {
    mine: {
      PosA1111aaaa: { target: "SrcWaLLet", pool: POOL, mint: MINT, scrSym: "WIF", shape: "BidAsk", scrTier: "CORE", solIn: 3,
                      minBin: 100, maxBin: 168, step: 80, ts: NOW - 90_000, closed: false, lastPnl: 1.5, peakPnl: 2.1, ladderId: "PosA1111aaaa" },
      PosB2222bbbb: { pool: POOL, mint: MINT, shape: "Spot", solIn: 1, minBin: 100, maxBin: 130, step: 80, ts: NOW - 60_000, closed: false },
    },
  };
  const sf = path.join(idir("slp"), "copylp_state.json");
  fs.writeFileSync(sf, JSON.stringify(state));
  const calls = [];
  const tr = new Tracker({ store: E.store, instanceDir: idir, fetchFn: fakeFetch(calls) });
  await tr.runOnce(NOW);

  const rows = E.store.positions("slp");
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.pos === "PosA1111aaaa");
  assert.equal(a.symbol, "WIF"); assert.equal(a.tier, "CORE"); assert.equal(a.status, "open");
  assert.equal(a.tvl_usd, 200000); assert.equal(a.mcap_usd, 5_000_000); assert.equal(a.token_age_h, 72);
  assert.equal(a.fee_pace_4h, 2.4); assert.equal(a.fee_pace_1h, 3);
  const sl = JSON.parse(a.sl_config);
  assert.equal(sl.STOP_LOSS_PCT, "18"); assert.equal(sl._target, "SrcWaLLet:sl=off:hard=25"); assert.equal(sl._tier, "CORE");
  assert.equal(calls.filter(u => u.includes("datapi")).length, 1, "one pool lookup for both positions");

  // second pass: no new captures
  await tr.runOnce(NOW + 60_000);
  assert.equal(calls.filter(u => u.includes("datapi")).length, 1);

  // close A; the bot logged why
  E.store.addDecision("slp", "close", false, "  CLOSE PosA1111… (stop-loss -18.4%)");
  state.mine.PosA1111aaaa.closed = true; state.mine.PosA1111aaaa.lastPnl = -18.4;
  fs.writeFileSync(sf, JSON.stringify(state));
  await tr.runOnce(NOW + 120_000);
  const a2 = E.store.positions("slp").find(r => r.pos === "PosA1111aaaa");
  assert.equal(a2.status, "closed"); assert.equal(a2.last_pnl_pct, -18.4); assert.equal(a2.peak_pnl_pct, 2.1);
  assert.equal(a2.closed_at, NOW + 120_000); assert.equal(a2.close_reason, "stop-loss -18.4%");
  // features from entry are unchanged by the close
  assert.equal(a2.fee_pace_4h, 2.4);
});

test("tracker skips instances that have not written state yet", async t => {
  const E = tmpEnv(); t.after(E.cleanup);
  E.store.addInstance("t", { id: "cp", strategy: "copylp" });
  const tr = new Tracker({ store: E.store, instanceDir: id => path.join(E.dir, "instances", id), fetchFn: async () => { throw new Error("no"); } });
  await tr.runOnce(NOW);
  assert.equal(E.store.positions().length, 0);
});
