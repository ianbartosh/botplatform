#!/usr/bin/env node
"use strict";
// bp — command line for the bot platform. Everything the portal will do, available today.
// Run `node bp.js help` for the list.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("./engine/db");
const { Keystore, isSecretKey } = require("./engine/keystore");
const { STRATEGIES, strategy, validate } = require("./engine/strategies");
const { paths, runEngine } = require("./engine/engine");
const { parseEnv } = require("./engine/envfile");
const auth = require("./engine/auth");

const P = paths();
const ACTOR = `cli:${os.userInfo().username}`;
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { const [k, v] = argv[i].slice(2).split("="); flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true); }
  else pos.push(argv[i]);
}

const die = m => { console.error(`error: ${m}`); process.exit(1); };
const store = () => new Store(P.db);
const keystore = s => new Keystore(s, process.env.BP_MASTER_KEY);
const need = (n, usage) => { if (pos.length < n) die(`usage: node bp.js ${usage}`); };
// Ask for a new password twice without showing it (works with piped input too).
// Returns "" when the first answer is empty (= generate one).
function askNewPassword(name) {
  const readline = require("readline");
  const q1 = `Password for ${name} (10+ characters; press Enter to generate one): `, q2 = "Repeat: ";
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let current = q1;
    if (process.stdin.isTTY) rl._writeToOutput = str => { if (str.includes(current)) rl.output.write(current); else if (/\r|\n/.test(str)) rl.output.write("\n"); };
    const answers = [];
    const ask = q => { current = q; rl.setPrompt(q); rl.prompt(); };
    rl.on("line", line => {
      answers.push(line.trim());
      if (answers.length === 1 && answers[0]) return ask(q2);
      rl.close();
    });
    rl.on("close", () => {
      if (!process.stdin.isTTY) process.stdout.write("\n");
      if (!answers[0]) return resolve("");
      if (answers[1] !== answers[0]) return reject(new Error("the two passwords differ"));
      resolve(answers[0]);
    });
    ask(q1);
  });
}
const fmtTs = t => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "-");
const mask = v => (v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-4)}`);

const MANAGED = new Set(["STATE_FILE", "LOCK_OVERRIDE", "DRY_RUN", "BOT_DATA_DIR", "BOT_NAME", "SCREENER_PICKS"]);

function printStatus() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(P.status, "utf8")); } catch {}
  const live = st && Date.now() - st.at < 20_000;
  const s = store();
  const rows = s.listInstances();
  console.log(live ? `engine: running (pid ${st.pid}, status ${Math.round((Date.now() - st.at) / 1000)}s old)` : "engine: NOT running");
  console.log("");
  console.log("id              strategy     owner  enabled  mode     state       wallet");
  for (const r of rows) {
    const x = live ? (st.instances.find(i => i.id === r.id) || {}) : {};
    console.log(`${r.id.padEnd(16)}${r.strategy.padEnd(13)}${r.owner.padEnd(7)}${(r.enabled ? "yes" : "no").padEnd(9)}${(r.dry_run ? "dry-run" : "LIVE").padEnd(9)}${(x.state || "-").padEnd(12)}${r.wallet || ""}`);
    if (x.error) console.log(`${"".padEnd(16)}! ${x.error}`);
  }
  if (live) {
    console.log("");
    for (const [h, v] of Object.entries(st.limiter || {})) console.log(`limiter ${h}: ${v.requests} requests${v.rps ? `, capped at ${v.rps}/s` : ""}`);
  }
  s.close();
}

function bucket(v, edges, unit = "") {
  if (v === null || v === undefined) return "unknown";
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return `${i ? edges[i - 1] : "<"}${i ? "–" : ""}${edges[i]}${unit}`;
  return `${edges[edges.length - 1]}${unit}+`;
}
function leversReport(rows) {
  const closed = rows.filter(r => r.status === "closed" && r.last_pnl_pct !== null);
  console.log(`${closed.length} closed positions with a result (of ${rows.length} tracked)\n`);
  if (!closed.length) return;
  const dims = {
    "shape": r => r.shape || "unknown",
    "range width %": r => bucket(r.width_pct, [20, 40, 60, 80], "%"),
    "fee pace 4h %/day": r => bucket(r.fee_pace_4h, [2, 4, 8, 16, 32]),
    "fee pace 1h %/day": r => bucket(r.fee_pace_1h, [2, 4, 8, 16, 32]),
    "TVL $": r => bucket(r.tvl_usd, [25e3, 100e3, 500e3, 2e6]),
    "token age h": r => bucket(r.token_age_h, [24, 168, 720]),
    "tier": r => r.tier || "-",
    "close reason": r => (r.close_reason || "unknown").replace(/[0-9.+-]+%?/g, "#"),
  };
  for (const [name, f] of Object.entries(dims)) {
    const g = new Map();
    for (const r of closed) { const k = f(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    console.log(name);
    for (const [k, list] of [...g].sort((a, b) => b[1].length - a[1].length)) {
      const pnl = list.map(r => r.last_pnl_pct), sol = list.reduce((a, r) => a + (r.sol_in || 0), 0);
      const avg = pnl.reduce((a, b) => a + b, 0) / pnl.length, win = pnl.filter(x => x > 0).length / pnl.length * 100;
      console.log(`  ${String(k).padEnd(22)} n=${String(list.length).padEnd(5)} avg ${avg.toFixed(2).padStart(7)}%  win ${win.toFixed(0).padStart(3)}%  ${sol.toFixed(1)} SOL in`);
    }
    console.log("");
  }
  console.log("Tracker PnL % per position (fees included as the bots measure them). Small groups are noise: read n first.");
}

const HELP = `
bp — bot platform command line                     data: ${P.dataDir}

  setup
    init                                    create the database (needs BP_MASTER_KEY)
    strategies                              list what can run

  instances
    add <id> <strategy> [--owner josh]      new instance (starts disabled, in dry-run)
    import <id> <strategy> <file> [--owner] copy settings + secrets from an old bot's .env
           [--no-keys]                      (screener: its screener_settings.json); --no-keys
                                            leaves the wallet key out (dry-run testing)
    list | status                           all instances; status also shows what is running
    show <id>                               settings, secret names (never values), problems
    set <id> KEY=VALUE [KEY=VALUE ...]      change settings (the worker restarts within ~5s)
    unset <id> KEY [KEY ...]
    secret <id> KEY <value|->               store a secret encrypted ('-' reads it from stdin)
    enable <id> | disable <id>              start / stop it (when the engine is running)
    dry <id> | live <id> --confirm <id>     switch mode; going live needs the id typed twice
    owner <id> <name>
    remove <id>

  running
    run                                     run the engine in this window (Ctrl+C stops everything)
    limit <host> <rps>                      shared request cap, e.g. limit dlmm.datapi.meteora.ag 5

  portal users
    user add <name> --role admin|operator   create a login (asks for a password; Enter = generate one)
    user passwd <name>                      change a password
    user list | user remove <name>
                                            add --2fa to add/passwd to also require an authenticator code
                                            operators see only bots whose owner is their name

  results
    positions [id] [--open]                 tracked positions with their entry levers
    levers [id]                             closed-position results grouped by each lever
    decisions <id> [--hours 24]             opens/closes/skips the bot logged
    logs <id> [--lines 100]                 recent log lines
    audit [--n 30]                          who changed what
`;

async function main() {
  switch (cmd) {
    case undefined: case "help": case "--help": console.log(HELP); return;
    case "strategies":
      for (const [k, s] of Object.entries(STRATEGIES)) console.log(`${k.padEnd(12)} ${s.label} — legacy v${s.version}${s.needsWallet ? ", needs a wallet" : ""}`);
      return;
    case "init": {
      const s = store(); keystore(s); s.close();
      console.log(`ok — database ready at ${P.db}`);
      return;
    }
    case "add": {
      need(2, "add <id> <strategy> [--owner name]");
      strategy(pos[1]);
      const s = store(); s.addInstance(ACTOR, { id: pos[0], strategy: pos[1], owner: flags.owner || "ian" }); s.close();
      console.log(`added '${pos[0]}' (${pos[1]}) — disabled, dry-run. Next: set its settings, then: node bp.js enable ${pos[0]}`);
      return;
    }
    case "import": {
      need(3, "import <id> <strategy> <file> [--owner name]");
      const [id, strat, file] = pos;
      strategy(strat);
      const text = fs.readFileSync(file, "utf8");
      const s = store(); const ks = keystore(s);
      const kv = strat === "screener"
        ? Object.fromEntries(Object.entries(JSON.parse(text)).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
        : parseEnv(text);
      s.addInstance(ACTOR, { id, strategy: strat, owner: flags.owner || "ian", note: `imported from ${path.resolve(file)}` });
      let nSet = 0, nSec = 0; const skipped = [];
      for (const [k, v] of Object.entries(kv)) {
        if (MANAGED.has(k)) { skipped.push(k); continue; }
        if (v === "" || /^REDACTED/.test(v)) { skipped.push(k); continue; }
        if (flags["no-keys"] && k === "PRIVATE_KEY") { skipped.push(k); continue; }
        if (isSecretKey(k)) { ks.setSecret(ACTOR, id, k, v); nSec++; }
        else { s.setSetting(ACTOR, id, k, v); nSet++; }
      }
      const inst = s.getInstance(id);
      const errs = validate(inst, s.getSettings(id), s.secretKeys(id), s.listInstances());
      s.close();
      console.log(`imported '${id}': ${nSet} settings, ${nSec} secrets (encrypted). Starts disabled, in dry-run.`);
      if (skipped.length) console.log(`skipped (managed by the engine or empty): ${skipped.join(", ")}`);
      if (errs.length) console.log(`still needed before it can start:\n  - ${errs.join("\n  - ")}`);
      return;
    }
    case "list": case "status": printStatus(); return;
    case "show": {
      need(1, "show <id>");
      const s = store(); const inst = s.getInstance(pos[0]); if (!inst) die(`no instance '${pos[0]}'`);
      const settings = s.getSettings(inst.id), sec = s.secretKeys(inst.id);
      console.log(`${inst.id}  ${inst.strategy}  owner=${inst.owner}  ${inst.enabled ? "ENABLED" : "disabled"}  ${inst.dry_run ? "dry-run" : "LIVE"}`);
      if (inst.wallet) console.log(`wallet ${inst.wallet}`);
      if (inst.note) console.log(inst.note);
      console.log("\nsettings:");
      for (const [k, v] of Object.entries(settings)) console.log(`  ${k}=${v}`);
      console.log(`\nsecrets: ${sec.length ? sec.join(", ") : "(none)"}`);
      if (process.env.BP_MASTER_KEY && flags.peek) { const vals = keystore(s).secrets(inst.id); for (const k of sec) console.log(`  ${k}=${mask(vals[k])}`); }
      const errs = validate(inst, settings, sec, s.listInstances());
      console.log(errs.length ? `\nproblems:\n  - ${errs.join("\n  - ")}` : "\nready to start");
      s.close();
      return;
    }
    case "set": {
      need(2, "set <id> KEY=VALUE [...]");
      const s = store(); if (!s.getInstance(pos[0])) die(`no instance '${pos[0]}'`);
      for (const kv of pos.slice(1)) {
        const i = kv.indexOf("="); if (i < 1) die(`'${kv}' is not KEY=VALUE`);
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (MANAGED.has(k)) die(`${k} is managed by the engine`);
        if (isSecretKey(k)) die(`${k} looks like a secret — use: node bp.js secret ${pos[0]} ${k} -`);
        s.setSetting(ACTOR, pos[0], k, v);
        console.log(`${pos[0]}: ${k}=${v}`);
      }
      s.close(); return;
    }
    case "unset": {
      need(2, "unset <id> KEY [...]");
      const s = store();
      for (const k of pos.slice(1)) { if (s.secretKeys(pos[0]).includes(k)) s.deleteSecret(ACTOR, pos[0], k); else s.unsetSetting(ACTOR, pos[0], k); console.log(`${pos[0]}: removed ${k}`); }
      s.close(); return;
    }
    case "secret": {
      need(3, "secret <id> KEY <value|->");
      const v = pos[2] === "-" ? fs.readFileSync(0, "utf8").trim() : pos[2];
      if (!v) die("empty value");
      const s = store(); if (!s.getInstance(pos[0])) die(`no instance '${pos[0]}'`);
      keystore(s).setSecret(ACTOR, pos[0], pos[1], v); s.close();
      console.log(`${pos[0]}: secret ${pos[1]} stored (encrypted)`);
      return;
    }
    case "enable": case "disable": {
      need(1, `${cmd} <id>`);
      const s = store(); s.setFlag(ACTOR, pos[0], "enabled", cmd === "enable"); s.close();
      console.log(`${pos[0]}: ${cmd}d — the engine picks this up within ~5s`);
      return;
    }
    case "dry": case "live": {
      need(1, `${cmd} <id>`);
      if (cmd === "live" && flags.confirm !== pos[0]) die(`going live trades real money. Repeat the id: node bp.js live ${pos[0]} --confirm ${pos[0]}`);
      const s = store(); const inst = s.getInstance(pos[0]); if (!inst) die(`no instance '${pos[0]}'`);
      if (cmd === "live") {
        const errs = validate({ ...inst, dry_run: 0 }, s.getSettings(inst.id), s.secretKeys(inst.id), s.listInstances());
        if (errs.length) die(`not ready to trade live:\n  - ${errs.join("\n  - ")}`);
      }
      s.setFlag(ACTOR, pos[0], "dry_run", cmd === "dry"); s.close();
      console.log(`${pos[0]}: now ${cmd === "dry" ? "dry-run" : "LIVE"}`);
      return;
    }
    case "limit": {
      need(2, "limit <host> <requests-per-second>   (0 = unlimited)");
      const s = store();
      const cur = JSON.parse(s.getMeta("limits") || "{}");
      cur[pos[0]] = { rps: Number(pos[1]), burst: Math.max(0, Math.round(Number(pos[1]) / 2)) };
      s.setMeta("limits", JSON.stringify(cur)); s.audit(ACTOR, null, "limit.set", { host: pos[0], rps: Number(pos[1]) }); s.close();
      console.log(`${pos[0]}: ${Number(pos[1]) || "unlimited"} req/s across all bots — restart the engine to apply`);
      return;
    }
    case "user": {
      const sub = pos[0];
      const twofa = !!flags["2fa"];
      const show = u => {
        if (u.password) console.log(`  password:  ${u.password}   (generated — shown only now)`);
        if (u.totp) {
          console.log(`  2FA key:   ${u.totp}`);
          console.log(`  In an authenticator app: add account -> "Enter a setup key", time-based.`);
        }
      };
      if (sub === "add" || sub === "passwd" || sub === "reset") {
        need(2, `user ${sub} <name>${sub === "add" ? " [--role admin|operator]" : ""} [--2fa]`);
        const name = pos[1].toLowerCase();
        const pw = await askNewPassword(name);
        const s = store();
        const u = sub === "add" ? auth.addUser(s, ACTOR, name, flags.role || "operator", { password: pw || null, twofa })
                                : auth.setPassword(s, ACTOR, name, { password: pw || null, twofa });
        s.close();
        console.log(`${sub === "add" ? "Created" : "Updated"} portal user '${name}'${u.role ? ` (${u.role})` : ""}${u.totp ? " with 2FA" : ""}.`);
        show(u);
        console.log("If the engine is running, this takes effect at the next login.");
      } else if (sub === "remove") { need(2, "user remove <name>"); const s = store(); auth.removeUser(s, ACTOR, pos[1].toLowerCase()); s.close(); console.log(`removed '${pos[1]}'`); }
      else if (sub === "list" || !sub) { const s = store(); for (const u of auth.listUsers(s)) console.log(`${u.name.padEnd(12)} ${u.role.padEnd(9)} since ${fmtTs(u.created_at)}`); s.close(); }
      else die("usage: node bp.js user add|passwd|remove|list");
      return;
    }
    case "owner": { need(2, "owner <id> <name>"); const s = store(); s.setField(ACTOR, pos[0], "owner", pos[1]); s.close(); console.log("ok"); return; }
    case "remove": { need(1, "remove <id>"); const s = store(); s.removeInstance(ACTOR, pos[0]); s.close(); console.log(`removed '${pos[0]}' (its data folder is kept)`); return; }
    case "run": { await runEngine({}); return; }
    case "positions": {
      const s = store(); const rows = s.positions(pos[0] || null, flags.open ? "open" : null); s.close();
      console.log("opened            instance        symbol    shape    tier   SOL    width%  tvl$k   pace1h pace4h  ageH    pnl%   peak%  status");
      for (const r of rows.slice(0, Number(flags.n || 60))) {
        const f = (v, d = 1, w = 7) => (v === null || v === undefined ? "-" : (+v).toFixed(d)).padStart(w);
        console.log(`${fmtTs(r.opened_at || r.first_seen)}  ${r.instance_id.padEnd(15)} ${(r.symbol || (r.mint || "").slice(0, 6)).padEnd(9)} ${(r.shape || "-").padEnd(8)} ${(r.tier || "-").padEnd(6)}${f(r.sol_in, 2, 5)} ${f(r.width_pct)} ${f(r.tvl_usd && r.tvl_usd / 1000, 0)} ${f(r.fee_pace_1h)} ${f(r.fee_pace_4h)} ${f(r.token_age_h, 0)} ${f(r.last_pnl_pct)} ${f(r.peak_pnl_pct)}  ${r.status}${r.close_reason ? " (" + r.close_reason + ")" : ""}`);
      }
      return;
    }
    case "levers": { const s = store(); leversReport(s.positions(pos[0] || null)); s.close(); return; }
    case "decisions": {
      need(1, "decisions <id> [--hours 24]");
      const s = store(); const rows = s.decisions(pos[0], Date.now() - Number(flags.hours || 24) * 3600_000, Number(flags.n || 300)); s.close();
      for (const r of rows.reverse()) console.log(`${fmtTs(r.ts)} ${r.dry ? "dry " : "LIVE"} ${r.kind.padEnd(5)} ${r.line}`);
      return;
    }
    case "logs": {
      need(1, "logs <id> [--lines 100]");
      const dir = path.join(P.logs, pos[0]);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort() : [];
      if (!files.length) die(`no logs for '${pos[0]}' yet`);
      const lines = fs.readFileSync(path.join(dir, files.at(-1)), "utf8").trimEnd().split("\n");
      console.log(lines.slice(-Number(flags.lines || 100)).join("\n"));
      return;
    }
    case "audit": {
      const s = store(); const rows = s.auditLog(Number(flags.n || 30)); s.close();
      for (const r of rows.reverse()) console.log(`${fmtTs(r.ts)} ${r.actor.padEnd(18)} ${(r.instance_id || "").padEnd(15)} ${r.action.padEnd(16)} ${r.detail || ""}`);
      return;
    }
    default: die(`unknown command '${cmd}' — run: node bp.js help`);
  }
}

main().catch(e => die(e.message));

