"use strict";
// The supervisor turns database rows into running bots. It is the ONLY thing that starts or stops
// a worker, and it enforces the rules that used to be lock files and ghost checks:
//   - one worker per instance;
//   - one LIVE worker per wallet (two signers on one wallet = doubled positions);
//   - a crashed worker restarts with backoff; a hung one (no heartbeat) is killed and restarted;
//   - a settings change restarts that instance's worker within seconds (legacy bots read env at boot).
const { Worker } = require("worker_threads");
const EventEmitter = require("events");
const path = require("path");
const { Keypair } = require("@solana/web3.js");
const bs58mod = require("bs58");
const { strategy, validate, buildEnv } = require("./strategies");
const { SharedLimiter, DEFAULT_LIMITS } = require("./limiter");

const bs58 = bs58mod.decode ? bs58mod : bs58mod.default;
const HOST = path.join(__dirname, "worker-host.js");

function walletOf(privateKey) {
  const k = String(privateKey || "").trim();
  if (!k) return null;
  const bytes = k.startsWith("[") ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k);
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

class Supervisor extends EventEmitter {
  constructor({ store, keystore, logs, dataDir, limits = DEFAULT_LIMITS, reconcileMs = 5000,
                pingMs = 30_000, hangMs = 150_000, backoffBaseMs = 5000, backoffMaxMs = 300_000, healthyResetMs = 600_000,
                blockedRetryMs = 60_000 }) {
    super();
    Object.assign(this, { store, keystore, logs, dataDir, reconcileMs, pingMs, hangMs, backoffBaseMs, backoffMaxMs, healthyResetMs, blockedRetryMs });
    this.limits = limits;
    this.limiter = new SharedLimiter(limits);
    this.slots = new Map();   // id -> { worker, startedAt, stamp, wallet, dry, lastPong, stopping }
    this.state = new Map();   // id -> { restarts, nextTry, blocked, lastExit }
    this.timer = null;
  }
  instanceDir(id) { return path.join(this.dataDir, "instances", id); }
  st(id) { if (!this.state.has(id)) this.state.set(id, { restarts: 0, nextTry: 0, blocked: null, lastExit: null }); return this.state.get(id); }

  // ---- lifecycle ----
  startLoop() {
    if (this.timer) return;
    const run = () => { try { this.reconcile(); } catch (e) { this.emit("error", e); } };
    run();
    this.timer = setInterval(run, this.reconcileMs);
    this.pinger = setInterval(() => this.heartbeat(), this.pingMs);
  }
  async shutdown() {
    clearInterval(this.timer); clearInterval(this.pinger); this.timer = null;
    await Promise.all([...this.slots.keys()].map(id => this.stop(id, "engine shutdown")));
  }

  reconcile(now = Date.now()) {
    const all = this.store.listInstances();
    for (const inst of all) {
      const slot = this.slots.get(inst.id), st = this.st(inst.id);
      if (!inst.enabled) { if (slot && !slot.stopping) this.stop(inst.id, "disabled"); continue; }
      if (slot) {
        if (!slot.stopping && inst.updated_at > slot.stamp) {
          this.logs.write(inst.id, "[engine] settings changed — restarting worker", { stream: "err", dry: !!inst.dry_run });
          this.stop(inst.id, "settings changed").then(() => { st.nextTry = 0; });
        }
        continue;
      }
      if (now < st.nextTry) continue;
      try { this.start(inst, all); st.blocked = null; }
      catch (e) {
        if (st.blocked !== e.message) this.logs.write(inst.id, `[engine] cannot start: ${e.message}`, { stream: "err", dry: !!inst.dry_run });
        st.blocked = e.message;
        st.nextTry = now + this.blockedRetryMs;
      }
    }
    for (const id of this.slots.keys()) if (!all.find(i => i.id === id)) this.stop(id, "instance removed");
  }

  start(inst, all = this.store.listInstances()) {
    if (this.slots.has(inst.id)) return;
    const s = strategy(inst.strategy);
    const settings = this.store.getSettings(inst.id);
    const secrets = this.keystore.secrets(inst.id);
    const errs = validate(inst, settings, Object.keys(secrets), all);
    if (errs.length) throw new Error(errs.join("; "));

    let wallet = null;
    if (s.needsWallet && secrets.PRIVATE_KEY) {
      wallet = walletOf(secrets.PRIVATE_KEY);
      if (wallet !== inst.wallet) this.store.setField("engine", inst.id, "wallet", wallet);
    }
    if (wallet && !inst.dry_run) {
      for (const [oid, o] of this.slots) {
        if (o.wallet === wallet && !o.dry) throw new Error(`wallet ${wallet.slice(0, 6)}… is already trading live in '${oid}' — one live worker per wallet`);
      }
    }

    const env = buildEnv(inst, settings, secrets, { dataDir: this.dataDir, instanceDir: id => this.instanceDir(id) });
    const worker = new Worker(HOST, {
      workerData: { script: s.script, argv: [], limiterSab: this.limiter.sab, limits: this.limits, instanceId: inst.id },
      env, stdout: true, stderr: true,
    });
    const stamp = this.store.getInstance(inst.id).updated_at;   // after any wallet write above
    const slot = { worker, startedAt: Date.now(), stamp, wallet, dry: !!inst.dry_run, lastPong: Date.now(), stopping: false, exited: null };
    slot.exited = new Promise(res => worker.once("exit", res));
    this.slots.set(inst.id, slot);
    const isDry = () => slot.dry;
    this.logs.attach(inst.id, worker.stdout, "out", isDry);
    this.logs.attach(inst.id, worker.stderr, "err", isDry);
    worker.on("message", m => { if (m && m.type === "pong") slot.lastPong = Date.now(); });
    worker.on("error", e => this.logs.write(inst.id, `[engine] worker error: ${e && e.stack || e}`, { stream: "err", dry: slot.dry }));
    worker.on("exit", code => this.onExit(inst.id, slot, code));
    this.logs.write(inst.id, `[engine] started ${inst.strategy} v${s.version} ${slot.dry ? "DRY-RUN" : "LIVE"}${wallet ? " wallet " + wallet : ""}`, { stream: "err", dry: slot.dry });
    this.store.audit("engine", inst.id, "worker.start", { dry: slot.dry, wallet });
    this.emit("started", inst.id);
  }

  async stop(id, reason = "stop") {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (!slot.stopping) {
      slot.stopping = true;
      this.logs.write(id, `[engine] stopping (${reason})`, { stream: "err", dry: slot.dry });
      try { await slot.worker.terminate(); } catch {}
    }
    await slot.exited;
  }

  onExit(id, slot, code) {
    if (this.slots.get(id) === slot) this.slots.delete(id);
    const st = this.st(id);
    st.lastExit = { at: Date.now(), code };
    if (slot.stopping) { this.emit("stopped", id); return; }
    // unexpected exit -> back off and let reconcile() restart it
    if (Date.now() - slot.startedAt > this.healthyResetMs) st.restarts = 0;
    st.restarts += 1;
    const delay = Math.min(this.backoffBaseMs * 2 ** (st.restarts - 1), this.backoffMaxMs);
    st.nextTry = Date.now() + delay;
    this.logs.write(id, `[engine] worker exited (code ${code}) — restart #${st.restarts} in ${Math.round(delay / 1000)}s`, { stream: "err", dry: slot.dry });
    this.store.audit("engine", id, "worker.crash", { code, restarts: st.restarts, delayMs: delay });
    this.emit("crashed", id, code);
  }

  heartbeat(now = Date.now()) {
    for (const [id, slot] of this.slots) {
      if (slot.stopping) continue;
      if (now - slot.lastPong > this.hangMs) {
        this.logs.write(id, `[engine] no heartbeat for ${Math.round((now - slot.lastPong) / 1000)}s — killing hung worker`, { stream: "err", dry: slot.dry });
        slot.worker.terminate().catch(() => {});   // exit handler treats it as a crash -> restart
        continue;
      }
      try { slot.worker.postMessage({ type: "ping" }); } catch {}
    }
  }

  status() {
    return this.store.listInstances().map(inst => {
      const slot = this.slots.get(inst.id), st = this.st(inst.id);
      const state = slot ? (slot.stopping ? "stopping" : "running")
        : !inst.enabled ? "stopped" : st.blocked ? "blocked" : st.nextTry > Date.now() ? "restarting" : "starting";
      return { id: inst.id, strategy: inst.strategy, owner: inst.owner, enabled: !!inst.enabled, dry_run: !!inst.dry_run,
               wallet: inst.wallet, state, since: slot ? slot.startedAt : null, restarts: st.restarts,
               error: st.blocked, lastExit: st.lastExit };
    });
  }
}

module.exports = { Supervisor, walletOf };
