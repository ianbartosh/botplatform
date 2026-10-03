"use strict";
// The portal: a small HTTP server inside the engine process (no extra dependencies).
// It binds to 127.0.0.1 only; people reach it through Tailscale (`tailscale serve`), never the
// open internet. Every request after login carries a session cookie; every change also needs the
// X-BP header, which a browser will not send cross-site — so other websites cannot act for you.
//
// Roles: admin sees and controls everything (plus the kill switch); an operator sees and controls
// only instances whose owner is their user name. Secrets are write-only: names are shown, values never.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Auth } = require("./auth");
const { isSecretKey } = require("./keystore");
const { strategy, validate, STRATEGIES } = require("./strategies");

const STATIC = path.join(__dirname, "..", "portal");
const MANAGED = new Set(["STATE_FILE", "LOCK_OVERRIDE", "DRY_RUN", "BOT_DATA_DIR", "BOT_NAME", "SCREENER_PICKS"]);
const COOKIE = "bp_session";

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new HttpError(413, "body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(bad("invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

class Portal {
  constructor({ store, keystore, sup, logs, dataDir, auth = null }) {
    Object.assign(this, { store, keystore, sup, logs, dataDir });
    this.auth = auth || new Auth(store);
    this.routes = [];
    this.defineRoutes();
  }

  // ---------- access ----------
  visible(user) {
    const all = this.store.listInstances();
    return user.role === "admin" ? all : all.filter(i => i.owner === user.name);
  }
  instanceFor(user, id) {
    const inst = this.store.getInstance(id);
    if (!inst || (user.role !== "admin" && inst.owner !== user.name)) throw new HttpError(404, "no such instance");
    return inst;
  }
  admin(user) { if (user.role !== "admin") throw new HttpError(403, "admin only"); }
  actor(user) { return `portal:${user.name}`; }

  // ---------- routing ----------
  on(method, pattern, handler, { open = false } = {}) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, handler, open });
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://local");
    try {
      if (!url.pathname.startsWith("/api/")) return this.serveStatic(url.pathname, res);
      const route = this.routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new HttpError(404, "not found");
      if (req.method !== "GET" && req.headers["x-bp"] !== "1") throw new HttpError(403, "missing X-BP header");
      const params = {};
      const m = url.pathname.match(route.re);
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const token = cookies(req)[COOKIE];
      const user = this.auth.session(token);
      if (!route.open && !user) throw new HttpError(401, "please log in");
      const body = req.method === "GET" ? {} : await readBody(req);
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
      const out = await route.handler({ user, params, query: url.searchParams, body, req, res, token, ip });
      if (res.headersSent) return;
      this.json(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) this.logs.write("_engine", `[portal] ${req.method} ${url.pathname}: ${e.stack || e}`, { stream: "err" });
      if (!res.headersSent) this.json(res, status, { error: status === 500 ? "internal error" : e.message });
    }
  }
  json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
  }
  serveStatic(p, res) {
    const file = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    if (!/^[a-z0-9_.-]+$/i.test(file)) { res.writeHead(404); return res.end(); }
    const full = path.join(STATIC, file);
    if (!fs.existsSync(full)) { res.writeHead(404); return res.end(); }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    fs.createReadStream(full).pipe(res);
  }

  // ---------- views ----------
  statusOf(id) { return this.sup.status().find(s => s.id === id) || {}; }
  instanceView(inst, detail = false) {
    const st = this.statusOf(inst.id);
    const v = { id: inst.id, strategy: inst.strategy, label: STRATEGIES[inst.strategy]?.label || inst.strategy, owner: inst.owner,
                enabled: !!inst.enabled, dry_run: !!inst.dry_run, wallet: inst.wallet, state: st.state || "stopped",
                since: st.since || null, restarts: st.restarts || 0, error: st.error || null,
                open_positions: this.store.positions(inst.id, "open").length,
                commands: Object.keys(STRATEGIES[inst.strategy]?.commands || {}) };
    if (detail) {
      const settings = this.store.getSettings(inst.id), secrets = this.store.secretKeys(inst.id);
      Object.assign(v, { settings, secrets, note: inst.note,
        problems: validate(inst, settings, secrets, this.store.listInstances()),
        live_problems: validate({ ...inst, dry_run: 0 }, settings, secrets, this.store.listInstances()) });
    }
    return v;
  }
  summary(rows) {
    const closed = rows.filter(r => r.status === "closed" && r.last_pnl_pct !== null);
    const solIn = closed.reduce((a, r) => a + (r.sol_in || 0), 0);
    const solPnl = closed.reduce((a, r) => a + (r.sol_in || 0) * r.last_pnl_pct / 100, 0);
    return { open: rows.filter(r => r.status === "open").length, closed: closed.length,
             win_pct: closed.length ? +(closed.filter(r => r.last_pnl_pct > 0).length / closed.length * 100).toFixed(1) : null,
             sol_in: +solIn.toFixed(3), sol_pnl_est: +solPnl.toFixed(3) };
  }

  defineRoutes() {
    // --- session ---
    this.on("POST", "/api/login", ({ body, res, ip }) => {
      let r;
      try { r = this.auth.login({ name: String(body.name || "").trim().toLowerCase(), password: body.password, code: body.code, ip }); }
      catch (e) {
        if (e.needCode) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message, need_code: true })); return; }
        throw new HttpError(401, e.message);
      }
      const { token, user } = r;
      res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
      return { user };
    }, { open: true });
    this.on("POST", "/api/logout", ({ token, res }) => {
      this.auth.logout(token);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return { ok: true };
    }, { open: true });
    this.on("GET", "/api/me", ({ user }) => ({ user }));

    // --- instances ---
    this.on("GET", "/api/instances", ({ user }) => {
      const rows = this.visible(user);
      const totals = this.summary(rows.flatMap(i => this.store.positions(i.id)));
      return { instances: rows.map(i => this.instanceView(i)), totals, strategies: Object.keys(STRATEGIES) };
    });
    this.on("GET", "/api/instances/:id", ({ user, params }) => {
      const inst = this.instanceFor(user, params.id);
      return { instance: this.instanceView(inst, true), summary: this.summary(this.store.positions(inst.id)) };
    });
    this.on("POST", "/api/instances/:id/enable", ({ user, params, body }) => {
      const inst = this.instanceFor(user, params.id);
      this.store.setFlag(this.actor(user), inst.id, "enabled", !!body.on);
      return { ok: true };
    });
    this.on("POST", "/api/instances/:id/mode", ({ user, params, body }) => {
      const inst = this.instanceFor(user, params.id);
      if (body.live) {
        if (body.confirm !== inst.id) throw bad(`type the instance name (${inst.id}) to go live`);
        const errs = validate({ ...inst, dry_run: 0 }, this.store.getSettings(inst.id), this.store.secretKeys(inst.id), this.store.listInstances());
        if (errs.length) throw bad(`not ready to trade live: ${errs.join("; ")}`);
      }
      this.store.setFlag(this.actor(user), inst.id, "dry_run", !body.live);
      return { ok: true };
    });
    this.on("POST", "/api/instances/:id/settings", ({ user, params, body }) => {
      const inst = this.instanceFor(user, params.id);
      const set = body.set || {}, unset = body.unset || [];
      for (const k of [...Object.keys(set), ...unset]) {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) throw bad(`bad setting name '${k}'`);
        if (MANAGED.has(k)) throw bad(`${k} is managed by the engine`);
        if (isSecretKey(k) && k in set) throw bad(`${k} is a secret — use the Secrets box`);
      }
      for (const [k, v] of Object.entries(set)) this.store.setSetting(this.actor(user), inst.id, k, String(v));
      for (const k of unset) this.store.unsetSetting(this.actor(user), inst.id, k);
      return { ok: true };
    });
    this.on("POST", "/api/instances/:id/secrets", ({ user, params, body }) => {
      const inst = this.instanceFor(user, params.id);
      const key = String(body.key || "");
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw bad("bad secret name");
      if (body.remove) this.store.deleteSecret(this.actor(user), inst.id, key);
      else {
        const value = String(body.value || "").trim();
        if (!value) throw bad("empty value");
        this.keystore.setSecret(this.actor(user), inst.id, key, value);
      }
      return { ok: true };
    });
    this.on("POST", "/api/instances/:id/command", async ({ user, params, body }) => {
      const inst = this.instanceFor(user, params.id);
      const name = String(body.name || "");
      if (name === "closeAll" && body.confirm !== inst.id) throw bad(`type the instance name (${inst.id}) to close everything`);
      const args = name === "closePos" ? [String(body.pos || "")] : [];
      if (name === "closePos" && !/^[1-9A-HJ-NP-Za-km-z]{6,44}$/.test(args[0])) throw bad("bad position address");
      const r = await this.sup.runCommand(inst.id, name, args, { actor: this.actor(user) });
      return { ok: r.code === 0, code: r.code };
    });
    this.on("GET", "/api/instances/:id/logs", ({ user, params, query }) => {
      const inst = this.instanceFor(user, params.id);
      const n = Math.min(Number(query.get("n") || 300), 2000);
      return { lines: this.logs.tail(inst.id, n) };
    });
    this.on("GET", "/api/instances/:id/positions", ({ user, params, query }) => {
      const inst = this.instanceFor(user, params.id);
      return { positions: this.store.positions(inst.id, query.get("status") || null).slice(0, 500) };
    });
    this.on("GET", "/api/instances/:id/decisions", ({ user, params, query }) => {
      const inst = this.instanceFor(user, params.id);
      const hours = Math.min(Number(query.get("hours") || 24), 24 * 30);
      return { decisions: this.store.decisions(inst.id, Date.now() - hours * 3600_000, 1000) };
    });

    // --- screener board ---
    this.on("GET", "/api/instances/:id/picks", ({ user, params }) => {
      const inst = this.instanceFor(user, params.id);
      if (inst.strategy !== "screener") throw bad("not a screener");
      try { return { picks: JSON.parse(fs.readFileSync(path.join(this.sup.instanceDir(inst.id), "screener_picks.json"), "utf8")) }; }
      catch { return { picks: null }; }
    });

    // --- results across instances ---
    this.on("GET", "/api/positions", ({ user, query }) => {
      const ids = new Set(this.visible(user).map(i => i.id));
      const rows = this.store.positions(null, query.get("status") || null).filter(r => ids.has(r.instance_id));
      return { positions: rows.slice(0, 1000) };
    });
    this.on("GET", "/api/audit", ({ user, query }) => {
      const n = Math.min(Number(query.get("n") || 100), 1000);
      if (user.role === "admin") return { audit: this.store.auditLog(n) };
      const ids = new Set(this.visible(user).map(i => i.id));
      return { audit: this.store.auditLog(5000).filter(a => a.instance_id && ids.has(a.instance_id)).slice(0, n) };
    });
    this.on("GET", "/api/engine", ({ user }) => {
      this.admin(user);
      return { limiter: this.sup.limiter.stats(), pid: process.pid, uptime_s: Math.round(process.uptime()) };
    });

    // --- admin ---
    this.on("POST", "/api/instances", ({ user, body }) => {
      this.admin(user);
      strategy(String(body.strategy || ""));
      this.store.addInstance(this.actor(user), { id: String(body.id || "").trim(), strategy: body.strategy, owner: String(body.owner || "ian").trim() });
      return { ok: true };
    });
    this.on("POST", "/api/instances/:id/owner", ({ user, params, body }) => {
      this.admin(user);
      this.instanceFor(user, params.id);
      this.store.setField(this.actor(user), params.id, "owner", String(body.owner || "").trim());
      return { ok: true };
    });
    this.on("POST", "/api/killswitch", ({ user, body }) => {
      this.admin(user);
      if (body.confirm !== "PAUSE ALL") throw bad("type PAUSE ALL to confirm");
      const n = this.store.listInstances().filter(i => i.enabled);
      for (const i of n) this.store.setFlag(this.actor(user), i.id, "enabled", false);
      this.store.audit(this.actor(user), null, "killswitch.pause_all", { instances: n.map(i => i.id) });
      return { paused: n.map(i => i.id) };
    });
  }

  listen(port = 8787, host = "127.0.0.1") {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => { this.server.off("error", reject); resolve(this.server.address()); });
    });
  }
  close() {
    return new Promise(r => {
      if (!this.server) return r();
      const shut = () => { this.server.close(() => r()); this.server.closeAllConnections(); };
      if (this.server.listening) shut(); else this.server.once("listening", shut);
    });
  }
}

module.exports = { Portal };
