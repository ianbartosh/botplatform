"use strict";
// The long-running service: opens the database, unlocks the keystore, and runs the supervisor and
// the tracker until stopped. On Windows this is what NSSM runs as a service (scripts/install-service.ps1).
const fs = require("fs");
const path = require("path");
const { Store } = require("./db");
const { Keystore } = require("./keystore");
const { LogHub } = require("./logs");
const { Supervisor } = require("./supervisor");
const { Tracker } = require("./tracker");
const { SharedLimiter, DEFAULT_LIMITS } = require("./limiter");
const { Portal } = require("./portal");

function paths(dataDir = process.env.BP_DATA_DIR || path.join(__dirname, "..", "data")) {
  return { dataDir, db: path.join(dataDir, "botplatform.sqlite"), logs: path.join(dataDir, "logs"),
           lock: path.join(dataDir, "engine.lock"), status: path.join(dataDir, "status.json") };
}

// One engine per data folder. A second copy (e.g. the service plus a manual `bp run`) would mean two
// workers per wallet, so it refuses to start.
function acquireEngineLock(file) {
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - held.hb < 60_000) {
      try { process.kill(held.pid, 0); throw new Error(`another engine (pid ${held.pid}) is already running on this data folder`); }
      catch (e) { if (e.message.startsWith("another engine")) throw e; }
    }
  } catch (e) { if (e.message.startsWith("another engine")) throw e; }
  const write = () => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, hb: Date.now() }));
  write();
  const t = setInterval(write, 15_000); t.unref();
  return () => { clearInterval(t); try { const l = JSON.parse(fs.readFileSync(file, "utf8")); if (l.pid === process.pid) fs.unlinkSync(file); } catch {} };
}

function limitsFrom(store) {
  try { const j = JSON.parse(store.getMeta("limits") || "null"); if (j) return { ...DEFAULT_LIMITS, ...j }; } catch {}
  return DEFAULT_LIMITS;
}

async function runEngine({ dataDir, echo = true } = {}) {
  const P = paths(dataDir);
  fs.mkdirSync(P.dataDir, { recursive: true });
  const release = acquireEngineLock(P.lock);
  const store = new Store(P.db);
  const keystore = new Keystore(store, process.env.BP_MASTER_KEY);
  const logs = new LogHub(P.logs, store);
  const limits = limitsFrom(store);
  const sup = new Supervisor({ store, keystore, logs, dataDir: P.dataDir, limits });
  // the tracker's own Meteora/Jupiter calls draw from the same shared budget as the workers
  new SharedLimiter(limits, sup.limiter.sab).install(globalThis);
  const tracker = new Tracker({ store, instanceDir: id => sup.instanceDir(id), log: l => logs.write("_engine", l, { stream: "err" }) });

  if (echo) logs.onLine((id, e) => process.stdout.write(`${new Date(e.ts).toISOString().slice(11, 19)} ${id.padEnd(14)} ${e.line}\n`));
  logs.write("_engine", `[engine] up — pid ${process.pid}, data ${P.dataDir}`, { stream: "err" });

  const writeStatus = () => {
    try {
      const tmp = P.status + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, instances: sup.status(), limiter: sup.limiter.stats() }, null, 2));
      fs.renameSync(tmp, P.status);
    } catch {}
  };
  sup.on("error", e => logs.write("_engine", `[engine] ${e.stack || e}`, { stream: "err" }));
  sup.startLoop();
  tracker.start();

  // the portal: localhost only — remote access goes through Tailscale (scripts/portal-access.ps1)
  const port = Number(process.env.BP_PORTAL_PORT || store.getMeta("portal_port") || 8790);
  const portal = new Portal({ store, keystore, sup, logs, dataDir: P.dataDir });
  try {
    await portal.listen(port, "127.0.0.1");
    logs.write("_engine", `[engine] portal on http://127.0.0.1:${port}`, { stream: "err" });
  } catch (e) {
    logs.write("_engine", `[engine] PORTAL NOT STARTED: port ${port} is in use by another program (${e.code || e.message}). ` +
      `Pick another port: set BP_PORTAL_PORT, or run: bp portal-port <number>`, { stream: "err" });
  }
  const st = setInterval(writeStatus, 5000);
  writeStatus();

  let closing = false;
  const close = async sig => {
    if (closing) return;
    closing = true;
    logs.write("_engine", `[engine] ${sig} — stopping all workers`, { stream: "err" });
    clearInterval(st);
    tracker.stop();
    await portal.close();
    await sup.shutdown();
    writeStatus();
    store.close();
    release();
    process.exit(0);
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGBREAK", () => close("SIGBREAK"));   // Windows service stop (NSSM sends Ctrl+Break)
  return { store, sup, tracker, portal, close };
}

module.exports = { runEngine, paths, limitsFrom };
