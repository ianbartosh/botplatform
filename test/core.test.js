"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { tmpEnv } = require("./helpers");
const { Keystore, isSecretKey } = require("../engine/keystore");
const { SharedLimiter } = require("../engine/limiter");
const { parseEnv } = require("../engine/envfile");
const { buildEnv, validate, slConfig } = require("../engine/strategies");
const { classify } = require("../engine/logs");

test("keystore: round-trips, stores ciphertext only, rejects a wrong master key", t => {
  const E = tmpEnv(); t.after(E.cleanup);
  E.keystore.setSecret("t", "x", "PRIVATE_KEY", "super-secret-value-123");
  assert.equal(E.keystore.secrets("x").PRIVATE_KEY, "super-secret-value-123");
  const raw = E.store.secretBlobs("x")[0].blob;
  assert.ok(!raw.includes("super-secret"));
  assert.throws(() => new Keystore(E.store, "a-different-master-key"), /does not match/);
  assert.ok(!JSON.stringify(E.store.auditLog(10)).includes("super-secret"));
});

test("secret detection covers keys, tokens, webhooks and RPC URLs", () => {
  for (const k of ["PRIVATE_KEY", "HELIUS_API_KEY", "JUP_API_KEY", "SCREENER_GATE_TOKEN", "SLACK_WEBHOOK_URL", "RPC_URL"]) assert.ok(isSecretKey(k), k);
  for (const k of ["TARGET_WALLETS", "STOP_LOSS_PCT", "GROUP_BUDGETS"]) assert.ok(!isSecretKey(k), k);
});

test("limiter: burst passes free, then requests are spaced at 1/rps", () => {
  const L = new SharedLimiter({ "h.example": { rps: 10, burst: 2 } });
  const now = 1_000_000;
  const waits = Array.from({ length: 5 }, () => L.reserve(0, now));
  assert.deepEqual(waits, [0, 0, 0, 100, 200]);
  assert.equal(L.stats()["h.example"].requests, 5);
  assert.equal(L.bucketFor("https://h.example/x?y=1"), 0);
  assert.equal(L.bucketFor("https://other.example/"), -1);
});

test("limiter: two threads share one budget", async () => {
  const L = new SharedLimiter({ "h.example": { rps: 50, burst: 0 } });
  const code = `const { workerData, parentPort } = require("worker_threads");
    const { SharedLimiter } = require(${JSON.stringify(path.join(__dirname, "..", "engine", "limiter.js"))});
    const L = new SharedLimiter(workerData.limits, workerData.sab);
    const now = workerData.now; const w = []; for (let i = 0; i < 20; i++) w.push(L.reserve(0, now));
    parentPort.postMessage(w);`;
  const now = Date.now() + 10_000;
  const run = () => new Promise((res, rej) => {
    const w = new Worker(code, { eval: true, workerData: { sab: L.sab, limits: L.limits, now } });
    w.once("message", res); w.once("error", rej);
  });
  const [a, b] = await Promise.all([run(), run()]);
  const all = [...a, ...b].sort((x, y) => x - y);
  assert.equal(new Set(all).size, 40, "every request got its own slot");
  assert.equal(all.at(-1), 39 * 20, "40 requests at 50/s span 780ms");
});

test("parseEnv handles comments, quotes and export", () => {
  const e = parseEnv(`# c\nA=1\nexport B="two words"\nC='x=y'\nD=val # trailing\n\nBAD\n`);
  assert.deepEqual(e, { A: "1", B: "two words", C: "x=y", D: "val" });
});

test("buildEnv: copylp env, dry-run strips the key, live keeps it", t => {
  const E = tmpEnv(); t.after(E.cleanup);
  const idir = id => path.join(E.dir, "instances", id);
  const inst = { id: "cp", strategy: "copylp", dry_run: 1 };
  const env = buildEnv(inst, { TARGET_WALLETS: "abc:pct=10" }, { PRIVATE_KEY: "k", HELIUS_API_KEY: "h" }, { dataDir: E.dir, instanceDir: idir });
  assert.equal(env.DRY_RUN, "true"); assert.equal(env.PRIVATE_KEY, undefined); assert.equal(env.HELIUS_API_KEY, "h");
  assert.equal(env.STATE_FILE, path.join(idir("cp"), "copylp_state.json"));
  assert.equal(env.LOCK_OVERRIDE, "1"); assert.equal(env.TARGET_WALLETS, "abc:pct=10");
  const live = buildEnv({ ...inst, dry_run: 0 }, {}, { PRIVATE_KEY: "k" }, { dataDir: E.dir, instanceDir: idir });
  assert.equal(live.DRY_RUN, "false"); assert.equal(live.PRIVATE_KEY, "k");
});

test("buildEnv: screenerlp reads picks from its screener's folder; screener gets a JSON settings file", t => {
  const E = tmpEnv(); t.after(E.cleanup);
  const idir = id => path.join(E.dir, "instances", id);
  const env = buildEnv({ id: "slp", strategy: "screenerlp", dry_run: 1 }, { PICKS_FROM: "scr", SCREENER_BASE_SHAPE: "spot" }, {}, { dataDir: E.dir, instanceDir: idir });
  assert.equal(env.SCREENER_PICKS, path.join(idir("scr"), "screener_picks.json"));
  assert.equal(env.PICKS_FROM, undefined); assert.equal(env.SCREENER_BASE_SHAPE, "spot");
  const senv = buildEnv({ id: "scr", strategy: "screener", dry_run: 1 }, { LOOP_MIN: "60", WALLETS: '["A","B"]', NAME: "x" }, { SLACK_WEBHOOK_URL: "https://hooks.example/1" }, { dataDir: E.dir, instanceDir: idir });
  assert.equal(senv.BOT_DATA_DIR, idir("scr"));
  const json = JSON.parse(fs.readFileSync(path.join(idir("scr"), "screener_settings.json"), "utf8"));
  assert.deepEqual(json, { LOOP_MIN: 60, WALLETS: ["A", "B"], NAME: "x", SLACK_WEBHOOK_URL: "https://hooks.example/1" });
});

test("validate: engine-managed keys and wrong PICKS_FROM are rejected", () => {
  const all = [{ id: "scr", strategy: "screener" }, { id: "cp", strategy: "copylp" }];
  assert.deepEqual(validate({ strategy: "screenerlp", dry_run: 1 }, { PICKS_FROM: "scr" }, ["HELIUS_API_KEY"], all), []);
  assert.match(validate({ strategy: "screenerlp", dry_run: 1 }, { PICKS_FROM: "cp" }, ["HELIUS_API_KEY"], all).join(), /not a screener/);
  const errs = validate({ strategy: "copylp", dry_run: 0 }, { TARGET_WALLETS: "a", STATE_FILE: "x" }, ["HELIUS_API_KEY"], all).join("|");
  assert.match(errs, /STATE_FILE is managed/);
  assert.match(errs, /PRIVATE_KEY is required to trade live/);
});

test("slConfig picks the stop-loss levers only", () => {
  assert.deepEqual(slConfig({ STOP_LOSS_PCT: "20", IN_RANGE_HARD_SL_PCT: "30", TSL_ACTIVATE_PCT: "5", SPIKE_EXIT_PNL: "-3", MIN_MCAP_USD: "1" }),
    { STOP_LOSS_PCT: "20", IN_RANGE_HARD_SL_PCT: "30", TSL_ACTIVATE_PCT: "5", SPIKE_EXIT_PNL: "-3" });
});

test("log classifier recognises the legacy bots' decision lines", () => {
  assert.equal(classify("  [9mCE12] MIRROR 4fTt2a: Abc123-SOL bins 1..60 (30.0% wide)"), "open");
  assert.equal(classify("  [9mCE12] MIRROR-ADD 4fTt2a -> 7aB2c9"), "add");
  assert.equal(classify("  CLOSE 7aB2c9Xy… (stop-loss -20.1%)"), "close");
  assert.equal(classify("  [SCRN] TRIM 50% WIF (3 position(s))"), "trim");
  assert.equal(classify("  [9mCE12] skip 4fTt2a: tax 3.00%"), "skip");
  assert.equal(classify("UNCAUGHT: boom"), "error");
  assert.equal(classify("heartbeat: 12 open"), null);
});
