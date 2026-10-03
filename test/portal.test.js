"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { tmpEnv, until } = require("./helpers");
const { Supervisor } = require("../engine/supervisor");
const { Portal } = require("../engine/portal");
const A = require("../engine/auth");

// ---------- TOTP against the RFC 6238 test vectors ----------
test("TOTP matches RFC 6238 (SHA1)", () => {
  const secret = A.base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (const [t, want] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]])
    assert.equal(A.hotp(secret, Math.floor(t / 30), 8), want, `t=${t}`);
  const now = 1_700_000_000_000;
  const code = A.hotp(secret, Math.floor(now / 30000));
  assert.ok(A.verifyTotp(secret, code, now) >= 0);
  assert.ok(A.verifyTotp(secret, code, now + 30_000) >= 0, "one step of clock drift is accepted");
  assert.equal(A.verifyTotp(secret, code, now + 95_000), -1, "old codes expire");
  assert.equal(A.verifyTotp(secret, "12345", now), -1);
});

test("passwords: hash, verify, reject", () => {
  const h = A.hashPassword("correct horse");
  assert.ok(A.checkPassword("correct horse", h));
  assert.ok(!A.checkPassword("wrong", h));
  assert.match(A.randomPassword(), /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
});

// ---------- portal API ----------
function setup(t) {
  const E = tmpEnv();
  const sup = new Supervisor({ store: E.store, keystore: E.keystore, logs: E.logs, dataDir: E.dir, reconcileMs: 50, pingMs: 100, backoffBaseMs: 100 });
  const portal = new Portal({ store: E.store, keystore: E.keystore, sup, logs: E.logs, dataDir: E.dir });
  const ian = A.addUser(E.store, "t", "ian", "admin");
  const josh = A.addUser(E.store, "t", "josh", "operator");
  E.store.addInstance("t", { id: "ian-bot", strategy: "fake", owner: "ian" });
  E.store.addInstance("t", { id: "josh-bot", strategy: "fake", owner: "josh" });
  E.keystore.setSecret("t", "ian-bot", "HELIUS_API_KEY", "super-secret-helius-value");
  let base;
  const ready = portal.listen(0).then(a => { base = `http://127.0.0.1:${a.port}`; });
  t.after(async () => { await portal.close(); await sup.shutdown(); E.cleanup(); });
  let stepOffset = 0;
  const login = async (u, opts = {}) => {
    await ready;
    // each login needs a fresh TOTP step (replays are refused), so step through future codes
    const code = opts.code ?? A.hotp(u.totp, Math.floor(Date.now() / 30000) + (stepOffset++ % 2));
    const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-BP": "1" },
      body: JSON.stringify({ name: u.name, password: opts.password ?? u.password, code }) });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    return { status: r.status, body: await r.json(), cookie };
  };
  const call = async (cookie, path, body, { xbp = true } = {}) => {
    await ready;
    const r = await fetch(`${base}/api${path}`, body === undefined ? { headers: { cookie } }
      : { method: "POST", headers: { cookie, "Content-Type": "application/json", ...(xbp ? { "X-BP": "1" } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null), text: null };
  };
  return { ...E, sup, portal, ian, josh, login, call, ready: () => ready.then(() => base) };
}

test("portal: login with password + 2FA; wrong code, no session, missing X-BP are refused", async t => {
  const S = setup(t);
  assert.equal((await S.call("", "/instances")).status, 401);
  const bad = await S.login(S.ian, { code: "000000" });
  assert.equal(bad.status, 401);
  const badPw = await S.login(S.ian, { password: "nope" });
  assert.equal(badPw.status, 401);
  const ok = await S.login(S.ian);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.role, "admin");
  assert.match(ok.cookie, /^bp_session=/);
  assert.equal((await S.call(ok.cookie, "/instances/ian-bot/enable", { on: true }, { xbp: false })).status, 403);
  assert.equal((await S.call(ok.cookie, "/me")).body.user.name, "ian");
});

test("portal: a TOTP code cannot be reused", async t => {
  const S = setup(t);
  const code = A.hotp(S.ian.totp, Math.floor(Date.now() / 30000));
  assert.equal((await S.login(S.ian, { code })).status, 200);
  assert.equal((await S.login(S.ian, { code })).status, 401);
});

test("portal: five failures lock the account", async t => {
  const S = setup(t);
  for (let i = 0; i < 5; i++) await S.login(S.josh, { password: "wrong" });
  const r = await S.login(S.josh);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /too many attempts/);
});

test("portal: an operator sees and controls only their own bots", async t => {
  const S = setup(t);
  const { cookie } = await S.login(S.josh);
  const list = await S.call(cookie, "/instances");
  assert.deepEqual(list.body.instances.map(i => i.id), ["josh-bot"]);
  assert.equal((await S.call(cookie, "/instances/ian-bot")).status, 404);
  assert.equal((await S.call(cookie, "/instances/ian-bot/enable", { on: true })).status, 404);
  assert.equal((await S.call(cookie, "/instances/ian-bot/logs")).status, 404);
  assert.equal((await S.call(cookie, "/killswitch", { confirm: "PAUSE ALL" })).status, 403);
  assert.equal((await S.call(cookie, "/instances", { id: "x1", strategy: "fake" })).status, 403);
  assert.equal((await S.call(cookie, "/instances/josh-bot/enable", { on: true })).status, 200);
  assert.equal(S.store.getInstance("josh-bot").enabled, 1);
  assert.equal(S.store.auditLog(5).find(a => a.action === "instance.enabled").actor, "portal:josh");
  const audit = await S.call(cookie, "/audit");
  assert.ok(audit.body.audit.every(a => a.instance_id === "josh-bot"));
});

test("portal: secret values never leave the server; settings guard secrets and engine keys", async t => {
  const S = setup(t);
  const { cookie } = await S.login(S.ian);
  const d = await S.call(cookie, "/instances/ian-bot");
  assert.deepEqual(d.body.instance.secrets, ["HELIUS_API_KEY"]);
  assert.ok(!JSON.stringify(d.body).includes("super-secret"));
  assert.equal((await S.call(cookie, "/instances/ian-bot/settings", { set: { HELIUS_API_KEY: "x" } })).status, 400);
  assert.equal((await S.call(cookie, "/instances/ian-bot/settings", { set: { STATE_FILE: "x" } })).status, 400);
  assert.equal((await S.call(cookie, "/instances/ian-bot/settings", { set: { STOP_LOSS_PCT: "15" }, unset: [] })).status, 200);
  assert.equal(S.store.getSettings("ian-bot").STOP_LOSS_PCT, "15");
  assert.equal((await S.call(cookie, "/instances/ian-bot/secrets", { key: "JUP_API_KEY", value: "jup-secret-value" })).status, 200);
  assert.equal(S.keystore.secrets("ian-bot").JUP_API_KEY, "jup-secret-value");
  assert.ok(!JSON.stringify((await S.call(cookie, "/audit")).body).includes("jup-secret-value"));
});

test("portal: going live needs the name typed and a wallet key", async t => {
  const S = setup(t);
  const { cookie } = await S.login(S.ian);
  assert.match((await S.call(cookie, "/instances/ian-bot/mode", { live: true })).body.error, /type the instance name/);
  assert.match((await S.call(cookie, "/instances/ian-bot/mode", { live: true, confirm: "ian-bot" })).body.error, /PRIVATE_KEY/);
  assert.equal(S.store.getInstance("ian-bot").dry_run, 1);
});

test("portal: kill switch pauses every bot", async t => {
  const S = setup(t);
  S.store.setFlag("t", "ian-bot", "enabled", true);
  S.store.setFlag("t", "josh-bot", "enabled", true);
  const { cookie } = await S.login(S.ian);
  assert.equal((await S.call(cookie, "/killswitch", { confirm: "nope" })).status, 400);
  const r = await S.call(cookie, "/killswitch", { confirm: "PAUSE ALL" });
  assert.deepEqual(r.body.paused.sort(), ["ian-bot", "josh-bot"]);
  assert.ok(S.store.listInstances().every(i => !i.enabled));
});

test("portal: close-all stops the bot, runs the close, and the bot restarts", async t => {
  const S = setup(t);
  S.store.setFlag("t", "josh-bot", "enabled", true);
  S.sup.startLoop();
  assert.ok(await until(() => S.sup.status().find(s => s.id === "josh-bot").state === "running"));
  const { cookie } = await S.login(S.josh);
  assert.equal((await S.call(cookie, "/instances/josh-bot/command", { name: "closeAll" })).status, 400, "needs confirmation");
  const r = await S.call(cookie, "/instances/josh-bot/command", { name: "closeAll", confirm: "josh-bot" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.code, 0);
  const lines = S.logs.tail("josh-bot", 500).map(e => e.line);
  assert.ok(lines.some(l => /CLI close-all done/.test(l)), "command output captured");
  assert.ok(S.store.auditLog(20, "josh-bot").some(a => a.action === "command.closeAll" && a.actor === "portal:josh"));
  assert.ok(await until(() => S.sup.status().find(s => s.id === "josh-bot").state === "running"), "restarted after the close");
});
