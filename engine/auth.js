"use strict";
// Portal authentication: scrypt password hashes, TOTP 2FA (RFC 6238 — Google Authenticator, Authy,
// 1Password all work), in-memory sessions, and a login lockout. Users live in the `users` table.
const crypto = require("crypto");

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const want = Buffer.from(hash, "base64");
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
function randomPassword() {
  // 4 groups of 5 from an unambiguous alphabet: easy to type once, ~100 bits
  const A = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.randomBytes(20);
  return Array.from({ length: 4 }, (_, g) => Array.from({ length: 5 }, (_, i) => A[b[g * 5 + i] % A.length]).join("")).join("-");
}

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function hotp(secretB32, counter, digits = 6, algo = "sha1") {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}
const step = (t = Date.now()) => Math.floor(t / 1000 / 30);
// Returns the matched time step (for replay protection) or -1.
function verifyTotp(secretB32, code, t = Date.now(), window = 1) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return -1;
  const now = step(t);
  for (let d = -window; d <= window; d++) {
    const a = Buffer.from(hotp(secretB32, now + d)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return now + d;
  }
  return -1;
}
function otpauthUri(user, secret, issuer = "botplatform") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- users ----------
// 2FA is optional per user (off by default). A user without a TOTP secret logs in with a password only.
const MIN_PW = 10;
function checkNewPassword(pw) {
  if (String(pw || "").length < MIN_PW) throw new Error(`password must be at least ${MIN_PW} characters`);
}
function addUser(store, actor, name, role, { password = null, twofa = false } = {}) {
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) throw new Error("user name: 2-31 chars, a-z 0-9 _ -, starting with a letter");
  if (!["admin", "operator"].includes(role)) throw new Error("role must be admin or operator");
  if (store.q("SELECT 1 FROM users WHERE name = ?").get(name)) throw new Error(`user '${name}' already exists`);
  const pw = password || randomPassword();
  checkNewPassword(pw);
  const totp = twofa ? newTotpSecret() : null;
  store.q("INSERT INTO users (name, role, pw_hash, totp_secret, created_at) VALUES (?, ?, ?, ?, ?)").run(name, role, hashPassword(pw), totp, Date.now());
  store.audit(actor, null, "user.add", { name, role, twofa: !!totp });
  return { name, role, password: password ? null : pw, totp, uri: totp ? otpauthUri(name, totp) : null };
}
// New password (and optionally turn 2FA on or off). Existing sessions of that user are not kept.
function setPassword(store, actor, name, { password = null, twofa = false } = {}) {
  if (!getUser(store, name)) throw new Error(`no user '${name}'`);
  const pw = password || randomPassword();
  checkNewPassword(pw);
  const totp = twofa ? newTotpSecret() : null;
  store.q("UPDATE users SET pw_hash = ?, totp_secret = ? WHERE name = ?").run(hashPassword(pw), totp, name);
  store.audit(actor, null, "user.password", { name, twofa: !!totp });
  return { name, password: password ? null : pw, totp, uri: totp ? otpauthUri(name, totp) : null };
}
const resetUser = (store, actor, name, opts) => setPassword(store, actor, name, opts);
function removeUser(store, actor, name) {
  store.q("DELETE FROM users WHERE name = ?").run(name);
  store.audit(actor, null, "user.remove", { name });
}
function getUser(store, name) { return store.q("SELECT * FROM users WHERE name = ?").get(name) || null; }
function listUsers(store) { return store.q("SELECT name, role, created_at FROM users ORDER BY name").all(); }

// ---------- sessions + lockout ----------
class Auth {
  constructor(store, { sessionMs = 12 * 3600_000, maxFails = 5, lockMs = 15 * 60_000 } = {}) {
    Object.assign(this, { store, sessionMs, maxFails, lockMs });
    this.sessions = new Map();     // token -> { user, exp }
    this.fails = new Map();        // key (ip or user) -> { n, until }
    this.lastStep = new Map();     // user -> last accepted TOTP step (no replays)
  }
  locked(key, now = Date.now()) { const f = this.fails.get(key); return !!(f && f.until > now); }
  fail(key, now = Date.now()) {
    const f = this.fails.get(key) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= this.maxFails) { f.until = now + this.lockMs; f.n = 0; }
    this.fails.set(key, f);
  }
  // Returns { token, user } or throws with a message safe to show.
  login({ name, password, code, ip = "?" }, now = Date.now()) {
    const keys = [`ip:${ip}`, `user:${name}`];
    if (keys.some(k => this.locked(k, now))) throw new Error("too many attempts — wait 15 minutes");
    const u = getUser(this.store, String(name || ""));
    const pwOk = u ? checkPassword(password, u.pw_hash) : (checkPassword(password, hashPassword("x")), false);  // same cost either way
    if (u && pwOk && u.totp_secret && !String(code || "").trim()) {
      const e = new Error("enter the 6-digit code from your authenticator app");
      e.needCode = true;
      throw e;                                   // correct password: not counted as a failure
    }
    const st = !u || !pwOk ? -1 : u.totp_secret ? verifyTotp(u.totp_secret, code, now) : 0;
    if (!u || !pwOk || st < 0 || (u.totp_secret && st <= (this.lastStep.get(u.name) ?? -1))) {
      keys.forEach(k => this.fail(k, now));
      this.store.audit(`portal:${name || "?"}`, null, "login.fail", { ip });
      throw new Error("wrong user, password or code");
    }
    if (u.totp_secret) this.lastStep.set(u.name, st);
    keys.forEach(k => this.fails.delete(k));
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, { user: u.name, exp: now + this.sessionMs });
    this.store.audit(`portal:${u.name}`, null, "login.ok", { ip });
    return { token, user: { name: u.name, role: u.role } };
  }
  session(token, now = Date.now()) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (s.exp < now) { this.sessions.delete(token); return null; }
    const u = getUser(this.store, s.user);           // role changes / removal take effect at once
    if (!u) { this.sessions.delete(token); return null; }
    return { name: u.name, role: u.role };
  }
  logout(token) { this.sessions.delete(token); }
  logoutUser(name) { for (const [t, s] of this.sessions) if (s.user === name) this.sessions.delete(t); }
}

module.exports = { Auth, hashPassword, checkPassword, hotp, verifyTotp, newTotpSecret, base32Encode, base32Decode,
                   otpauthUri, addUser, setPassword, resetUser, removeUser, getUser, listUsers, randomPassword };
