"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../engine/db");
const { Keystore } = require("../engine/keystore");
const { LogHub } = require("../engine/logs");
const { STRATEGIES } = require("../engine/strategies");

STRATEGIES.fake = {
  label: "test bot", script: path.join(__dirname, "fixtures", "fakebot.js"), version: "t",
  needsWallet: true, tracks: null, stateFile: "fake_state.json", required: [], requiredSecrets: [],
  commands: { closeAll: () => ["--close-all"] },
};

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-test-"));
  const store = new Store(path.join(dir, "t.sqlite"));
  const keystore = new Keystore(store, "test-master-key-123");
  const logs = new LogHub(path.join(dir, "logs"), store);
  return { dir, store, keystore, logs, cleanup: () => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}
module.exports = { tmpEnv, sleep, until };
