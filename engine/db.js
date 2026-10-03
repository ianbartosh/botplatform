"use strict";
// SQLite store for everything the engine knows: instances, their settings and secrets, users,
// the audit trail, tracked positions and the lever features captured at entry.
// Uses Node's built-in node:sqlite (Node >= 22.13), so there is no native module to build on Windows.
const _emitWarning = process.emitWarning;   // silence the one-time "SQLite is experimental" notice
process.emitWarning = (w, ...a) => (/SQLite is an experimental/.test(String(w)) ? undefined : _emitWarning.call(process, w, ...a));
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin','operator')),
  pw_hash TEXT, totp_secret TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY, strategy TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'ian',
  enabled INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL DEFAULT 1,
  wallet TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (
  instance_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (instance_id, key));
CREATE TABLE IF NOT EXISTS secrets (
  instance_id TEXT NOT NULL, key TEXT NOT NULL, blob TEXT NOT NULL,
  PRIMARY KEY (instance_id, key));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  instance_id TEXT, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS positions (
  instance_id TEXT NOT NULL, pos TEXT NOT NULL, pool TEXT, mint TEXT, symbol TEXT, target TEXT,
  shape TEXT, leg TEXT, tier TEXT, sol_in REAL, min_bin INTEGER, max_bin INTEGER, bin_step INTEGER,
  width_pct REAL, opened_at INTEGER, first_seen INTEGER NOT NULL, closed_at INTEGER,
  last_pnl_pct REAL, peak_pnl_pct REAL, status TEXT NOT NULL DEFAULT 'open', close_reason TEXT, ladder TEXT,
  PRIMARY KEY (instance_id, pos));
CREATE TABLE IF NOT EXISTS position_features (
  instance_id TEXT NOT NULL, pos TEXT NOT NULL, captured_at INTEGER NOT NULL, capture_lag_s REAL,
  tvl_usd REAL, mcap_usd REAL, volume_24h_usd REAL, token_age_h REAL, pool_age_h REAL,
  fee_pace_30m REAL, fee_pace_1h REAL, fee_pace_4h REAL, fee_pace_24h REAL,
  bin_step INTEGER, base_fee_pct REAL, shape TEXT, width_pct REAL, sl_config TEXT, raw TEXT,
  PRIMARY KEY (instance_id, pos));
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, instance_id TEXT NOT NULL,
  kind TEXT NOT NULL, dry INTEGER NOT NULL, line TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_inst_ts ON decisions (instance_id, ts);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
`;

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }
  q(sql) { return this.db.prepare(sql); }

  // ---- meta ----
  getMeta(k) { return this.q("SELECT value FROM meta WHERE key = ?").get(k)?.value ?? null; }
  setMeta(k, v) { this.q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v)); }

  // ---- audit ----
  audit(actor, instanceId, action, detail) {
    this.q("INSERT INTO audit (ts, actor, instance_id, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), actor, instanceId ?? null, action, detail === undefined ? null : JSON.stringify(detail));
  }
  auditLog(limit = 50, instanceId = null) {
    return instanceId
      ? this.q("SELECT * FROM audit WHERE instance_id = ? ORDER BY id DESC LIMIT ?").all(instanceId, limit)
      : this.q("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
  }

  // ---- instances ----
  touch(id) { this.q("UPDATE instances SET updated_at = ? WHERE id = ?").run(Date.now(), id); }
  getInstance(id) { return this.q("SELECT * FROM instances WHERE id = ?").get(id) || null; }
  listInstances(owner = null) {
    return owner ? this.q("SELECT * FROM instances WHERE owner = ? ORDER BY id").all(owner)
                 : this.q("SELECT * FROM instances ORDER BY id").all();
  }
  addInstance(actor, { id, strategy, owner = "ian", note = null }) {
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(id)) throw new Error(`instance id '${id}' must be 2-41 chars: a-z 0-9 _ -`);
    if (this.getInstance(id)) throw new Error(`instance '${id}' already exists`);
    const now = Date.now();
    this.q("INSERT INTO instances (id, strategy, owner, enabled, dry_run, note, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)")
      .run(id, strategy, owner, note, now, now);
    this.audit(actor, id, "instance.add", { strategy, owner });
  }
  removeInstance(actor, id) {
    const inst = this.getInstance(id);
    if (!inst) throw new Error(`no instance '${id}'`);
    if (inst.enabled) throw new Error(`disable '${id}' before removing it`);
    for (const t of ["instances", "settings", "secrets"]) this.q(`DELETE FROM ${t} WHERE ${t === "instances" ? "id" : "instance_id"} = ?`).run(id);
    this.audit(actor, id, "instance.remove", null);
  }
  setFlag(actor, id, flag, value) {
    if (!["enabled", "dry_run"].includes(flag)) throw new Error(`unknown flag ${flag}`);
    const inst = this.getInstance(id);
    if (!inst) throw new Error(`no instance '${id}'`);
    this.q(`UPDATE instances SET ${flag} = ?, updated_at = ? WHERE id = ?`).run(value ? 1 : 0, Date.now(), id);
    this.audit(actor, id, `instance.${flag}`, { from: !!inst[flag], to: !!value });
  }
  setField(actor, id, field, value) {
    if (!["owner", "note", "wallet"].includes(field)) throw new Error(`unknown field ${field}`);
    this.q(`UPDATE instances SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, Date.now(), id);
    this.audit(actor, id, `instance.${field}`, { to: value });
  }

  // ---- settings ----
  getSettings(id) {
    const out = {};
    for (const r of this.q("SELECT key, value FROM settings WHERE instance_id = ? ORDER BY key").all(id)) out[r.key] = r.value;
    return out;
  }
  setSetting(actor, id, key, value) {
    if (!this.getInstance(id)) throw new Error(`no instance '${id}'`);
    const before = this.q("SELECT value FROM settings WHERE instance_id = ? AND key = ?").get(id, key)?.value ?? null;
    this.q("INSERT INTO settings (instance_id, key, value) VALUES (?, ?, ?) ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value")
      .run(id, key, String(value));
    this.touch(id);
    this.audit(actor, id, "setting.set", { key, from: before, to: String(value) });
  }
  unsetSetting(actor, id, key) {
    const before = this.q("SELECT value FROM settings WHERE instance_id = ? AND key = ?").get(id, key)?.value ?? null;
    this.q("DELETE FROM settings WHERE instance_id = ? AND key = ?").run(id, key);
    this.touch(id);
    this.audit(actor, id, "setting.unset", { key, from: before });
  }

  // ---- secrets (blobs are already encrypted by the keystore) ----
  putSecretBlob(actor, id, key, blob) {
    this.q("INSERT INTO secrets (instance_id, key, blob) VALUES (?, ?, ?) ON CONFLICT(instance_id, key) DO UPDATE SET blob = excluded.blob").run(id, key, blob);
    this.touch(id);
    this.audit(actor, id, "secret.set", { key });   // never the value
  }
  deleteSecret(actor, id, key) {
    this.q("DELETE FROM secrets WHERE instance_id = ? AND key = ?").run(id, key);
    this.touch(id);
    this.audit(actor, id, "secret.unset", { key });
  }
  secretBlobs(id) { return this.q("SELECT key, blob FROM secrets WHERE instance_id = ? ORDER BY key").all(id); }
  secretKeys(id) { return this.secretBlobs(id).map(r => r.key); }

  // ---- positions + features ----
  getPosition(id, pos) { return this.q("SELECT * FROM positions WHERE instance_id = ? AND pos = ?").get(id, pos) || null; }
  upsertPosition(p) {
    this.q(`INSERT INTO positions (instance_id, pos, pool, mint, symbol, target, shape, leg, tier, sol_in, min_bin, max_bin,
              bin_step, width_pct, opened_at, first_seen, closed_at, last_pnl_pct, peak_pnl_pct, status, close_reason, ladder)
            VALUES (:instance_id, :pos, :pool, :mint, :symbol, :target, :shape, :leg, :tier, :sol_in, :min_bin, :max_bin,
              :bin_step, :width_pct, :opened_at, :first_seen, :closed_at, :last_pnl_pct, :peak_pnl_pct, :status, :close_reason, :ladder)
            ON CONFLICT(instance_id, pos) DO UPDATE SET
              close_reason = COALESCE(close_reason, excluded.close_reason),
              symbol = COALESCE(excluded.symbol, symbol), tier = COALESCE(excluded.tier, tier),
              sol_in = COALESCE(excluded.sol_in, sol_in), closed_at = COALESCE(closed_at, excluded.closed_at),
              last_pnl_pct = COALESCE(excluded.last_pnl_pct, last_pnl_pct),
              peak_pnl_pct = COALESCE(excluded.peak_pnl_pct, peak_pnl_pct), status = excluded.status`).run(p);
  }
  hasFeatures(id, pos) { return !!this.q("SELECT 1 FROM position_features WHERE instance_id = ? AND pos = ?").get(id, pos); }
  insertFeatures(f) {
    this.q(`INSERT OR IGNORE INTO position_features (instance_id, pos, captured_at, capture_lag_s, tvl_usd, mcap_usd,
              volume_24h_usd, token_age_h, pool_age_h, fee_pace_30m, fee_pace_1h, fee_pace_4h, fee_pace_24h, bin_step,
              base_fee_pct, shape, width_pct, sl_config, raw)
            VALUES (:instance_id, :pos, :captured_at, :capture_lag_s, :tvl_usd, :mcap_usd, :volume_24h_usd, :token_age_h,
              :pool_age_h, :fee_pace_30m, :fee_pace_1h, :fee_pace_4h, :fee_pace_24h, :bin_step, :base_fee_pct, :shape,
              :width_pct, :sl_config, :raw)`).run(f);
  }
  positions(id = null, status = null) {
    const where = [], args = [];
    if (id) { where.push("p.instance_id = ?"); args.push(id); }
    if (status) { where.push("p.status = ?"); args.push(status); }
    return this.q(`SELECT p.*, f.tvl_usd, f.mcap_usd, f.token_age_h, f.fee_pace_1h, f.fee_pace_4h, f.fee_pace_24h, f.sl_config
                   FROM positions p LEFT JOIN position_features f ON f.instance_id = p.instance_id AND f.pos = p.pos
                   ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.first_seen DESC`).all(...args);
  }

  // ---- decisions (dry-run comparison + live trail) ----
  addDecision(instanceId, kind, dry, line) {
    this.q("INSERT INTO decisions (ts, instance_id, kind, dry, line) VALUES (?, ?, ?, ?, ?)").run(Date.now(), instanceId, kind, dry ? 1 : 0, line.slice(0, 1000));
  }
  lastCloseLine(instanceId, posPrefix) {
    return this.q("SELECT line FROM decisions WHERE instance_id = ? AND kind = 'close' AND line LIKE ? ORDER BY id DESC LIMIT 1")
      .get(instanceId, `%CLOSE ${posPrefix}%`)?.line ?? null;
  }
  decisions(instanceId, sinceMs = 0, limit = 200) {
    return this.q("SELECT * FROM decisions WHERE instance_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?").all(instanceId, sinceMs, limit);
  }
}

module.exports = { Store };
