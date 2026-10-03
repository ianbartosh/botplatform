"use strict";
// The real legacy bots must load inside a worker thread exactly as they do under `node script.js`.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { Worker } = require("worker_threads");
const { SharedLimiter } = require("../engine/limiter");

const HOST = path.join(__dirname, "..", "engine", "worker-host.js");
function runHost(script, argv, env = {}) {
  const L = new SharedLimiter();
  return new Promise((resolve, reject) => {
    const w = new Worker(HOST, { workerData: { script, argv, limiterSab: L.sab, limits: L.limits, instanceId: "t" },
      env: { DOTENV_CONFIG_PATH: "/nonexistent", DOTENV_CONFIG_QUIET: "true", LOCK_OVERRIDE: "1", ...env }, stdout: true, stderr: true });
    let out = "";
    w.stdout.on("data", d => (out += d)); w.stderr.on("data", d => (out += d));
    const t = setTimeout(() => w.terminate(), 20_000);
    w.on("exit", code => { clearTimeout(t); resolve({ code, out }); });
    w.on("error", reject);
  });
}

test("worker host runs the script as the main module (require.main guard)", async () => {
  const r = await runHost(path.join(__dirname, "fixtures", "mainguard.js"), []);
  assert.match(r.out, /main-guard ran/);
});

for (const [file, re] of [["copylp.js", /copylp v0\.6\.23/], ["screenerlp.js", /v0\.7\.18/]]) {
  test(`legacy ${file} loads in a worker thread`, async () => {
    const r = await runHost(path.join(__dirname, "..", "legacy", file), ["--version"],
      { HELIUS_API_KEY: "x", TARGET_WALLETS: "11111111111111111111111111111111", STATE_FILE: path.join(require("os").tmpdir(), `bp-v-${file}.json`) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, re);
  });
}
