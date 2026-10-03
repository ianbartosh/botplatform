"use strict";
// Per-instance logs: an in-memory ring buffer (what the portal shows live) plus daily files on disk
// (kept LOG_KEEP_DAYS). Every line is also classified; trading decisions (opens, adds, closes,
// trims, skips, swaps, errors) are written to the decisions table so a dry-run can be compared
// line by line with what the old live bot did over the same hours.
const fs = require("fs");
const path = require("path");

const RING = 2000;
const LOG_KEEP_DAYS = 14;

const KINDS = [
  ["error", /\b(FATAL|UNCAUGHT|UNHANDLED)\b|\berror\b/i],
  ["add",   /\bMIRROR-ADD\b|\bADD LANDED\b|\badd (held|would)/],
  ["open",  /\bMIRROR\b|\bOPENED\b|\bchunk opened\b|\bwould (re)?open\b|\[SCRN\][^\n]*\b(OPEN|REOPEN|UPGRADE)\b/],
  ["close", /\bCLOSE [0-9A-Za-z]|\bBURST:|\bholding closed\b/],
  ["trim",  /\bTRIM(MED)?\b|\bspike trim\b/],
  ["skip",  /\] skip\b/],
  ["trade", /\b(BUY|SELL)\b/],
];
function classify(line) {
  for (const [k, re] of KINDS) if (re.test(line)) return k;
  return null;
}

class LogHub {
  constructor(dir, store) {
    this.dir = dir;
    this.store = store;
    this.rings = new Map();
    this.listeners = new Set();
    this.lastPrune = 0;
  }
  ring(id) { if (!this.rings.has(id)) this.rings.set(id, []); return this.rings.get(id); }
  tail(id, n = 200) { return this.ring(id).slice(-n); }
  onLine(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  write(id, line, { stream = "out", dry = true } = {}) {
    const ts = Date.now();
    const entry = { ts, stream, line };
    const r = this.ring(id);
    r.push(entry);
    if (r.length > RING) r.splice(0, r.length - RING);
    const day = new Date(ts).toISOString().slice(0, 10);
    const d = path.join(this.dir, id);
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, `${day}.log`), `${new Date(ts).toISOString()} ${stream === "err" ? "ERR " : ""}${line}\n`);
    } catch {}
    const kind = classify(line);
    if (kind && this.store) { try { this.store.addDecision(id, kind, dry, line); } catch {} }
    for (const fn of this.listeners) { try { fn(id, entry, kind); } catch {} }
    if (ts - this.lastPrune > 6 * 3600_000) this.prune(ts);
  }
  // Split a stream into lines and write each one.
  attach(id, stream, name, isDry) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) this.write(id, line, { stream: name, dry: isDry() });
      }
    });
    stream.on("end", () => { if (buf.trim()) this.write(id, buf, { stream: name, dry: isDry() }); buf = ""; });
  }
  prune(now = Date.now()) {
    this.lastPrune = now;
    const cutoff = new Date(now - LOG_KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
    let ids = [];
    try { ids = fs.readdirSync(this.dir); } catch { return; }
    for (const id of ids) {
      let files = [];
      try { files = fs.readdirSync(path.join(this.dir, id)); } catch { continue; }
      for (const f of files) if (/^\d{4}-\d{2}-\d{2}\.log$/.test(f) && f.slice(0, 10) < cutoff) { try { fs.unlinkSync(path.join(this.dir, id, f)); } catch {} }
    }
  }
}

module.exports = { LogHub, classify };
