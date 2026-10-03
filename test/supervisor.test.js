"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Keypair } = require("@solana/web3.js");
const bs58m = require("bs58");
const { tmpEnv, until, sleep } = require("./helpers");
const { Supervisor } = require("../engine/supervisor");

const bs58 = bs58m.encode ? bs58m : bs58m.default;
const newKey = () => { const k = Keypair.generate(); return { pk: bs58.encode(k.secretKey), addr: k.publicKey.toBase58() }; };
const lines = (logs, id) => logs.tail(id, 500).map(e => e.line);

function mk(t, opts = {}) {
  const E = tmpEnv();
  const sup = new Supervisor({ store: E.store, keystore: E.keystore, logs: E.logs, dataDir: E.dir,
    reconcileMs: 50, pingMs: 100, hangMs: 800, backoffBaseMs: 100, backoffMaxMs: 400, blockedRetryMs: 200, ...opts });
  t.after(async () => { await sup.shutdown(); E.cleanup(); });
  return { ...E, sup };
}

test("runs an enabled instance, captures its logs and decisions, stops on disable", async t => {
  const { store, logs, sup } = mk(t);
  store.addInstance("t", { id: "a1", strategy: "fake" });
  store.setFlag("t", "a1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => lines(logs, "a1").some(l => l.startsWith("fakebot up"))));
  assert.match(lines(logs, "a1").find(l => l.startsWith("fakebot up")), /dry=true key=no/);
  assert.ok(await until(() => store.decisions("a1").some(d => d.kind === "open" && d.dry === 1)));
  store.setFlag("t", "a1", "enabled", false);
  assert.ok(await until(() => sup.status().find(s => s.id === "a1").state === "stopped"));
});

test("dry-run never receives the private key; live does", async t => {
  const { store, keystore, logs, sup } = mk(t);
  const k = newKey();
  store.addInstance("t", { id: "d1", strategy: "fake" });
  keystore.setSecret("t", "d1", "PRIVATE_KEY", k.pk);
  store.setFlag("t", "d1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => lines(logs, "d1").some(l => /fakebot up.*key=no/.test(l))));
  assert.equal(store.getInstance("d1").wallet, k.addr);
  store.setFlag("t", "d1", "dry_run", false);           // bumps updated_at -> restart in live mode
  assert.ok(await until(() => lines(logs, "d1").some(l => /fakebot up.*dry=false key=yes/.test(l))));
});

test("refuses a second LIVE worker on the same wallet", async t => {
  const { store, keystore, logs, sup } = mk(t);
  const k = newKey();
  for (const id of ["w1", "w2"]) {
    store.addInstance("t", { id, strategy: "fake" });
    keystore.setSecret("t", id, "PRIVATE_KEY", k.pk);
    store.setFlag("t", id, "dry_run", false);
  }
  store.setFlag("t", "w1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => sup.status().find(s => s.id === "w1").state === "running"));
  store.setFlag("t", "w2", "enabled", true);
  assert.ok(await until(() => sup.status().find(s => s.id === "w2").state === "blocked"));
  assert.match(sup.status().find(s => s.id === "w2").error, /already trading live in 'w1'/);
  assert.ok(lines(logs, "w2").some(l => /cannot start/.test(l)));
  // once w1 stops, w2 is allowed
  store.setFlag("t", "w1", "enabled", false);
  assert.ok(await until(() => sup.status().find(s => s.id === "w2").state === "running", 3000));
});

test("a crashing worker is restarted with backoff", async t => {
  const { store, logs, sup } = mk(t);
  store.addInstance("t", { id: "c1", strategy: "fake" });
  store.setSetting("t", "c1", "FAKE_MODE", "crash");
  store.setFlag("t", "c1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => lines(logs, "c1").filter(l => l.startsWith("fakebot up")).length >= 3, 6000));
  assert.ok(lines(logs, "c1").some(l => /restart #2/.test(l)));
  assert.ok(store.auditLog(50, "c1").some(a => a.action === "worker.crash"));
});

test("a hung worker (no heartbeat) is killed and restarted", async t => {
  const { store, logs, sup } = mk(t);
  store.addInstance("t", { id: "h1", strategy: "fake" });
  store.setSetting("t", "h1", "FAKE_MODE", "hang");
  store.setFlag("t", "h1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => lines(logs, "h1").some(l => /no heartbeat/.test(l)), 6000));
  assert.ok(await until(() => lines(logs, "h1").filter(l => l.startsWith("fakebot up")).length >= 2, 6000));
});

test("a settings change restarts the worker with the new value", async t => {
  const { store, logs, sup } = mk(t);
  store.addInstance("t", { id: "s1", strategy: "fake" });
  store.setSetting("t", "s1", "FAKE_N", "1");
  store.setFlag("t", "s1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => lines(logs, "s1").some(l => /n=1$/.test(l))));
  await sleep(50);
  store.setSetting("t", "s1", "FAKE_N", "2");
  assert.ok(await until(() => lines(logs, "s1").some(l => /n=2$/.test(l))));
  assert.ok(lines(logs, "s1").some(l => /settings changed/.test(l)));
});

test("an instance with missing required settings is blocked, not crashed", async t => {
  const { store, sup } = mk(t);
  store.addInstance("t", { id: "b1", strategy: "copylp" });
  store.setFlag("t", "b1", "enabled", true);
  sup.startLoop();
  assert.ok(await until(() => sup.status().find(s => s.id === "b1").state === "blocked"));
  assert.match(sup.status().find(s => s.id === "b1").error, /TARGET_WALLETS is required/);
});
