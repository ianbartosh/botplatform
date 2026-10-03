"use strict";
// Bot Platform portal — plain JS, no build step. All text goes in through textContent (h()), never
// innerHTML, so nothing a bot logs or a setting contains can inject markup.

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const fmtTime = t => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const fmtAgo = t => { if (!t) return "–"; const s = (Date.now() - t) / 1000; return s < 90 ? `${s | 0}s` : s < 5400 ? `${(s / 60) | 0}m` : s < 172800 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? "–" : (+v).toFixed(d));
const signCls = v => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "–");

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = `toast${bad ? " bad" : ""}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), bad ? 6000 : 2500);
}
async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-BP": "1" }, body: JSON.stringify(body) };
  const r = await fetch(`/api${path}`, { credentials: "same-origin", ...opt });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path === "/login") { const e = new Error(j.error || "login failed"); e.needCode = !!j.need_code; throw e; }
  if (r.status === 401) { showLogin(); throw new Error("please log in"); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const act = (fn, ok) => async (...a) => { try { await fn(...a); if (ok) toast(ok); route(); } catch (e) { toast(e.message, true); } };

// ---------- session ----------
let ME = null, timer = null;
function showLogin() { ME = null; clearInterval(timer); $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginErr").textContent = "";
  try {
    const r = await api("/login", { name: f.get("name"), password: f.get("password"), code: f.get("code") });
    e.target.reset(); $("#codeRow").classList.add("hidden"); start(r.user);
  } catch (err) {
    if (err.needCode) { $("#codeRow").classList.remove("hidden"); $("#codeRow input").focus(); }
    $("#loginErr").textContent = err.message;
  }
});
$("#logout").addEventListener("click", async () => { await api("/logout", {}).catch(() => {}); showLogin(); });
function start(user) {
  ME = user;
  $("#who").textContent = `${user.name} · ${user.role}`;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  route();
}
window.addEventListener("hashchange", route);
api("/me").then(r => start(r.user)).catch(() => showLogin());

// ---------- router ----------
let detailTab = "overview";
function route() {
  if (!ME) return;
  clearInterval(timer);
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, page, id] = hash.split("/");
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.nav === (page === "i" ? "instances" : page || "instances")));
  const main = $("#main");
  const render = page === "i" ? () => viewInstance(main, decodeURIComponent(id)) :
                 page === "positions" ? () => viewPositions(main) :
                 page === "levers" ? () => viewLevers(main) :
                 page === "audit" ? () => viewAudit(main) : () => viewInstances(main);
  render().catch(e => toast(e.message, true));
  timer = setInterval(() => { if (!document.hidden && !document.querySelector("input:focus, textarea:focus")) render().catch(() => {}); }, page === "i" ? 4000 : 8000);
}

// ---------- instances ----------
async function viewInstances(main) {
  const r = await api("/instances");
  const t = r.totals;
  const kids = [
    h("div", { class: "stats" },
      stat(r.instances.filter(i => i.state === "running").length + " / " + r.instances.length, "bots running"),
      stat(r.instances.filter(i => i.enabled && !i.dry_run).length, "trading live"),
      stat(t.open, "open positions"),
      stat(t.closed, "closed positions"),
      stat(t.win_pct === null ? "–" : `${t.win_pct}%`, "closed in profit"),
      stat(`${t.sol_pnl_est >= 0 ? "+" : ""}${num(t.sol_pnl_est, 2)} SOL`, "est. PnL on closed (tracker)")),
  ];
  if (ME.role === "admin") kids.push(h("div", { class: "row spread", style: "margin-bottom:12px" },
    h("div", { class: "row" }, h("button", { class: "btn", onclick: newInstance }, "+ New bot")),
    h("button", { class: "btn danger", onclick: pauseAll }, "Pause all bots")));
  if (!r.instances.length) kids.push(h("p", { class: "muted" }, ME.role === "admin" ? "No bots yet." : "No bots are assigned to you yet."));
  kids.push(h("div", { class: "grid" }, r.instances.map(botCard)));
  put(main, ...kids);
}
function stat(v, k) { return h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "k" }, k)); }
function statePills(i) {
  return [h("span", { class: `pill ${i.state}` }, i.state), " ", i.dry_run ? h("span", { class: "pill" }, "DRY-RUN") : h("span", { class: "pill live" }, "LIVE")];
}
function botCard(i) {
  const go = () => (location.hash = `#/i/${encodeURIComponent(i.id)}`);
  return h("div", { class: "card bot", onclick: go },
    h("div", { class: "row spread head" },
      h("div", { class: "grow" }, h("div", { class: "name" }, i.id), h("div", { class: "muted" }, i.label)),
      h("label", { class: "switch", title: i.enabled ? "On — click to stop" : "Off — click to start", onclick: e => e.stopPropagation() },
        h("input", { type: "checkbox", checked: i.enabled, onchange: act(e => api(`/instances/${encodeURIComponent(i.id)}/enable`, { on: e.target.checked }), i.enabled ? "stopping…" : "starting…") }),
        h("span"))),
    h("div", { class: "row" }, ...statePills(i)),
    h("div", { class: "kv" },
      h("span", { class: "k" }, "owner"), h("span", {}, i.owner),
      h("span", { class: "k" }, "wallet"), h("span", { class: "mono" }, short(i.wallet)),
      h("span", { class: "k" }, "open"), h("span", {}, i.open_positions),
      h("span", { class: "k" }, "up"), h("span", {}, i.since ? fmtAgo(i.since) : "–")),
    i.error ? h("div", { class: "err wrap" }, i.error) : null);
}
async function newInstance() {
  const id = prompt("Name for the new bot (a-z, 0-9, - or _):"); if (!id) return;
  const strat = prompt("Strategy: copylp, screenerlp, screener or swapcopy", "copylp"); if (!strat) return;
  const owner = prompt("Owner (ian, josh, matt…):", "ian"); if (!owner) return;
  await act(() => api("/instances", { id: id.trim(), strategy: strat.trim(), owner: owner.trim() }), "bot added — it starts disabled, in dry-run")();
  location.hash = `#/i/${encodeURIComponent(id.trim())}`;
}
async function pauseAll() {
  const c = prompt("This stops EVERY bot (positions stay open). Type PAUSE ALL to confirm:");
  if (c !== "PAUSE ALL") return;
  await act(() => api("/killswitch", { confirm: c }), "all bots paused")();
}

// ---------- one instance ----------
async function viewInstance(main, id) {
  const { instance: i, summary } = await api(`/instances/${encodeURIComponent(id)}`);
  const base = `/instances/${encodeURIComponent(i.id)}`;
  const head = h("div", { class: "row spread" },
    h("div", {}, h("a", { href: "#/" }, "← Bots"), h("h1", { style: "margin:4px 0" }, i.id), h("div", { class: "muted" }, `${i.label} · owner ${i.owner}${i.wallet ? " · " : ""}`, i.wallet ? h("span", { class: "mono" }, i.wallet) : null)),
    h("div", { class: "row" }, ...statePills(i),
      h("button", { class: "btn", onclick: act(() => api(`${base}/enable`, { on: !i.enabled }), i.enabled ? "stopping…" : "starting…") }, i.enabled ? "Stop" : "Start"),
      i.dry_run ? h("button", { class: "btn danger", onclick: () => goLive(i) }, "Go live…")
                : h("button", { class: "btn", onclick: act(() => api(`${base}/mode`, { live: false }), "now dry-run") }, "Switch to dry-run"),
      i.commands.includes("closeAll") ? h("button", { class: "btn danger", onclick: () => closeAll(i) }, i.strategy === "swapcopy" ? "Sell all…" : "Close all…") : null));
  const tabs = ["overview", "settings", "secrets", "positions", "decisions", "logs"];
  if (i.strategy === "screener") tabs.push("picks");
  if (!tabs.includes(detailTab)) detailTab = "overview";
  const tabBar = h("div", { class: "tabs" }, tabs.map(t => h("button", { class: t === detailTab ? "on" : "", onclick: () => { detailTab = t; route(); } }, t[0].toUpperCase() + t.slice(1))));
  const body = h("div");
  put(main, head, i.error ? h("div", { class: "problems" }, h("b", {}, "Cannot start: "), i.error) : null, tabBar, body);
  const panes = { overview, settings, secrets, positions: posPane, decisions, logs: logPane, picks };
  await panes[detailTab](body, i, base, summary);
}
async function goLive(i) {
  if (i.live_problems.length) return toast(`Not ready to trade live: ${i.live_problems.join("; ")}`, true);
  const c = prompt(`LIVE trading uses real money from wallet ${i.wallet || "(set PRIVATE_KEY first)"}.\nMake sure the old bot for this wallet is stopped.\n\nType ${i.id} to confirm:`);
  if (c === null) return;
  await act(() => api(`/instances/${encodeURIComponent(i.id)}/mode`, { live: true, confirm: c }), "now LIVE")();
}
async function closeAll(i) {
  const c = prompt(`Close every open position of ${i.id}? The bot stops, closes, then restarts if it is on.\nType ${i.id} to confirm:`);
  if (c === null) return;
  toast("closing… this can take a minute");
  await act(() => api(`/instances/${encodeURIComponent(i.id)}/command`, { name: "closeAll", confirm: c }), "close-all finished — check the log")();
}

async function overview(body, i, base, s) {
  put(body, 
    h("div", { class: "stats" }, stat(s.open, "open positions"), stat(s.closed, "closed"), stat(s.win_pct === null ? "–" : `${s.win_pct}%`, "closed in profit"),
      stat(`${num(s.sol_pnl_est, 3)} SOL`, "est. PnL on closed"), stat(i.restarts, "restarts"), stat(i.since ? fmtAgo(i.since) : "–", "running for")),
    i.problems.length ? h("div", { class: "problems" }, h("b", {}, "Needs fixing before it can start:"), h("ul", {}, i.problems.map(p => h("li", {}, p)))) : null,
    i.dry_run && i.live_problems.length && !i.problems.length ? h("div", { class: "problems" }, h("b", {}, "Before it can go live: "), i.live_problems.join("; ")) : null,
    i.note ? h("p", { class: "muted" }, i.note) : null,
    h("p", { class: "muted" }, "Settings changes restart this bot within about 5 seconds. Every change is in the Audit tab."));
}

async function settings(body, i, base) {
  const rows = Object.entries(i.settings);
  const inputs = new Map();
  const del = new Set();
  const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Setting"), h("th", {}, "Value"), h("th"))),
    h("tbody", {}, rows.map(([k, v]) => {
      const inp = h("input", { value: v }); inputs.set(k, inp);
      const tr = h("tr", {}, h("td", { class: "mono" }, k), h("td", {}, inp),
        h("td", {}, h("button", { class: "btn small ghost", onclick: () => { del.has(k) ? del.delete(k) : del.add(k); tr.style.opacity = del.has(k) ? 0.4 : 1; } }, "remove")));
      return tr;
    })));
  const nk = h("input", { placeholder: "NEW_SETTING", style: "min-width:200px" }), nv = h("input", { placeholder: "value" });
  const save = async () => {
    const set = {};
    for (const [k, inp] of inputs) if (!del.has(k) && inp.value !== i.settings[k]) set[k] = inp.value;
    if (nk.value.trim()) set[nk.value.trim()] = nv.value;
    if (!Object.keys(set).length && !del.size) return toast("nothing changed");
    const what = [...Object.keys(set).map(k => `${k} = ${set[k]}`), ...[...del].map(k => `remove ${k}`)].join("\n");
    if (!confirm(`Apply to ${i.id}? The bot restarts.\n\n${what}`)) return;
    await act(() => api(`${base}/settings`, { set, unset: [...del] }), "saved — bot restarting")();
  };
  put(body, h("div", { class: "tablewrap" }, table),
    h("div", { class: "row", style: "margin-top:12px" }, nk, nv, h("button", { class: "btn primary", onclick: save }, "Save changes")));
}

async function secrets(body, i, base) {
  const k = h("input", { placeholder: "PRIVATE_KEY, HELIUS_API_KEY, RPC_URL…", style: "min-width:220px" });
  const v = h("input", { type: "password", placeholder: "value", autocomplete: "off" });
  put(body, 
    h("p", { class: "muted" }, "Secrets are stored encrypted and are never shown again — only their names. Setting one replaces it."),
    h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {}, i.secrets.length ? i.secrets.map(s => h("tr", {}, h("td", { class: "mono" }, s), h("td", { class: "muted" }, "•••••••• set"),
      h("td", { class: "num" }, h("button", { class: "btn small ghost", onclick: () => { k.value = s; v.focus(); } }, "replace"), " ",
        h("button", { class: "btn small danger", onclick: () => confirm(`Remove secret ${s}?`) && act(() => api(`${base}/secrets`, { key: s, remove: true }), "removed")() }, "remove"))))
      : h("tr", {}, h("td", { class: "muted" }, "No secrets yet."))))),
    h("div", { class: "row", style: "margin-top:12px" }, k, v,
      h("button", { class: "btn primary", onclick: act(async () => { await api(`${base}/secrets`, { key: k.value.trim(), value: v.value }); v.value = ""; }, "secret stored (encrypted)") }, "Store")));
}

function posTable(rows, { withInstance = false, closeFn = null } = {}) {
  const cols = [
    ...(withInstance ? [["Bot", r => r.instance_id]] : []),
    ["Opened", r => fmtTime(r.opened_at || r.first_seen)], ["Token", r => r.symbol || short(r.mint)], ["Shape", r => r.shape || "–"], ["Tier", r => r.tier || "–"],
    ["SOL", r => num(r.sol_in, 2), "num"], ["Width %", r => num(r.width_pct), "num"], ["TVL $k", r => num(r.tvl_usd / 1000, 0), "num"],
    ["Pace 1h", r => num(r.fee_pace_1h), "num"], ["Pace 4h", r => num(r.fee_pace_4h), "num"], ["Age h", r => num(r.token_age_h, 0), "num"],
    ["PnL %", r => h("span", { class: signCls(r.last_pnl_pct) }, num(r.last_pnl_pct)), "num"], ["Peak %", r => num(r.peak_pnl_pct), "num"],
    ["Status", r => r.status + (r.close_reason ? ` · ${r.close_reason}` : "")],
  ];
  return h("div", { class: "tablewrap" }, h("table", {},
    h("thead", {}, h("tr", {}, cols.map(c => h("th", { class: c[2] || "" }, c[0])), closeFn ? h("th") : null)),
    h("tbody", {}, rows.length ? rows.map(r => h("tr", {}, cols.map(c => h("td", { class: c[2] || "" }, c[1](r))),
      closeFn ? h("td", {}, r.status === "open" ? h("button", { class: "btn small danger", onclick: () => closeFn(r) }, "close") : null) : null))
      : h("tr", {}, h("td", { class: "muted", colspan: cols.length + 1 }, "No positions yet. Dry-run bots only log what they would do; positions appear once a bot trades.")))));
}
async function posPane(body, i, base) {
  const r = await api(`${base}/positions`);
  const closeFn = i.commands.includes("closePos") ? async p => {
    if (!confirm(`Close position ${p.pos} (${p.symbol || short(p.mint)})? The bot stops for the close, then restarts.`)) return;
    toast("closing…");
    await act(() => api(`${base}/command`, { name: "closePos", pos: p.pos }), "close finished — check the log")();
  } : null;
  put(body, posTable(r.positions, { closeFn }));
}

const KINDS = ["open", "add", "close", "trim", "trade", "skip", "error"];
let decFilter = new Set(["open", "add", "close", "trim", "trade"]), decHours = 24;
async function decisions(body, i, base) {
  const r = await api(`${base}/decisions?hours=${decHours}`);
  const rows = r.decisions.filter(d => decFilter.has(d.kind));
  put(body, 
    h("div", { class: "row", style: "margin-bottom:10px" },
      KINDS.map(k => h("label", { class: "row", style: "gap:4px;color:var(--text)" },
        h("input", { type: "checkbox", style: "width:auto", checked: decFilter.has(k), onchange: e => { e.target.checked ? decFilter.add(k) : decFilter.delete(k); route(); } }), k)),
      h("select", { style: "width:auto", onchange: e => { decHours = +e.target.value; route(); } },
        [6, 24, 72, 168].map(x => h("option", { value: x, selected: x === decHours ? "" : null }, `last ${x}h`)))),
    h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Mode"), h("th", {}, "Kind"), h("th", {}, "What the bot logged"))),
      h("tbody", {}, rows.length ? rows.map(d => h("tr", {}, h("td", {}, fmtTime(d.ts)), h("td", {}, d.dry ? "dry" : h("b", {}, "LIVE")), h("td", {}, d.kind), h("td", { class: "mono wrap" }, d.line.trim())))
        : h("tr", {}, h("td", { class: "muted", colspan: 4 }, "Nothing in this window."))))));
}

let logFollow = true;
async function logPane(body, i, base) {
  const r = await api(`${base}/logs?n=500`);
  const box = h("div", { class: "logs" }, r.lines.map(l => h("div", { class: l.stream === "err" ? "err" : "" },
    h("span", { class: "t" }, new Date(l.ts).toLocaleTimeString([], { hour12: false }) + "  "), l.line)));
  put(body, h("label", { class: "row", style: "gap:6px;margin-bottom:8px;color:var(--text)" },
    h("input", { type: "checkbox", style: "width:auto", checked: logFollow, onchange: e => (logFollow = e.target.checked) }), "follow newest"), box);
  if (logFollow) box.scrollTop = box.scrollHeight;
}

async function picks(body, i, base) {
  const r = await api(`${base}/picks`);
  const p = r.picks;
  const list = p ? (Array.isArray(p) ? p : p.picks || p.pools || []) : [];
  if (!list.length) return put(body, h("p", { class: "muted" }, p ? "No pools listed right now." : "The screener has not written picks yet (first scan takes a minute or two)."));
  const keys = Object.keys(list[0]).filter(k => typeof list[0][k] !== "object").slice(0, 12);
  put(body, p.at || p.ts ? h("p", { class: "muted" }, `updated ${fmtAgo(p.at || p.ts)} ago`) : null,
    h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, keys.map(k => h("th", {}, k)))),
      h("tbody", {}, list.map(x => h("tr", {}, keys.map(k => h("td", { class: typeof x[k] === "number" ? "num" : "" }, typeof x[k] === "number" ? +x[k].toFixed(2) : String(x[k] ?? "–")))))))));
}

// ---------- cross-bot views ----------
async function viewPositions(main) {
  const r = await api("/positions");
  put(main, h("h1", {}, "Positions"), posTable(r.positions, { withInstance: true }));
}

function bucket(v, edges, unit = "") {
  if (v === null || v === undefined) return "unknown";
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i ? `${edges[i - 1]}–${edges[i]}${unit}` : `< ${edges[i]}${unit}`;
  return `${edges[edges.length - 1]}${unit}+`;
}
const LEVERS = {
  "Shape": r => r.shape || "unknown",
  "Range width": r => bucket(r.width_pct, [20, 40, 60, 80], "%"),
  "Fee pace 4h (%/day)": r => bucket(r.fee_pace_4h, [2, 4, 8, 16, 32]),
  "Fee pace 1h (%/day)": r => bucket(r.fee_pace_1h, [2, 4, 8, 16, 32]),
  "Pool TVL ($)": r => bucket(r.tvl_usd, [25e3, 100e3, 500e3, 2e6]),
  "Token age (h)": r => bucket(r.token_age_h, [24, 168, 720]),
  "Tier": r => r.tier || "–",
  "Close reason": r => (r.close_reason || "unknown").replace(/[0-9.+-]+%?/g, "#"),
};
let leverInst = "";
async function viewLevers(main) {
  const r = await api("/positions?status=closed");
  const ids = [...new Set(r.positions.map(p => p.instance_id))].sort();
  const rows = r.positions.filter(p => p.last_pnl_pct !== null && (!leverInst || p.instance_id === leverInst));
  const sections = Object.entries(LEVERS).map(([name, f]) => {
    const g = new Map();
    for (const p of rows) { const k = f(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    const lines = [...g].sort((a, b) => b[1].length - a[1].length).map(([k, list]) => {
      const pnl = list.map(p => p.last_pnl_pct), avg = pnl.reduce((a, b) => a + b, 0) / pnl.length;
      const win = pnl.filter(x => x > 0).length / pnl.length * 100, sol = list.reduce((a, p) => a + (p.sol_in || 0), 0);
      const solPnl = list.reduce((a, p) => a + (p.sol_in || 0) * p.last_pnl_pct / 100, 0);
      return h("tr", {}, h("td", {}, k), h("td", { class: "num" }, list.length), h("td", { class: `num ${signCls(avg)}` }, `${num(avg, 2)}%`),
        h("td", { class: "num" }, `${num(win, 0)}%`), h("td", { class: "num" }, num(sol, 1)), h("td", { class: `num ${signCls(solPnl)}` }, num(solPnl, 2)));
    });
    return [h("h2", {}, name), h("div", { class: "tablewrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Group"), h("th", { class: "num" }, "n"), h("th", { class: "num" }, "avg PnL"), h("th", { class: "num" }, "in profit"),
        h("th", { class: "num" }, "SOL in"), h("th", { class: "num" }, "est. SOL PnL"))), h("tbody", {}, lines)))];
  });
  put(main, 
    h("div", { class: "row spread" }, h("h1", {}, "Levers"),
      h("select", { style: "width:auto", onchange: e => { leverInst = e.target.value; route(); } },
        h("option", { value: "" }, "all bots"), ids.map(id => h("option", { value: id, selected: id === leverInst ? "" : null }, id)))),
    h("p", { class: "muted" }, `${rows.length} closed positions. Each lever is captured when the position is first seen; PnL is the bot's tracker figure. Read n first — small groups are noise.`),
    ...(rows.length ? sections.flat() : [h("p", { class: "muted" }, "No closed positions yet.")]));
}

async function viewAudit(main) {
  const r = await api("/audit?n=200");
  put(main, h("h1", {}, "Audit"), h("div", { class: "tablewrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Who"), h("th", {}, "Bot"), h("th", {}, "What"), h("th", {}, "Detail"))),
    h("tbody", {}, r.audit.map(a => h("tr", {}, h("td", {}, fmtTime(a.ts)), h("td", {}, a.actor), h("td", {}, a.instance_id || "–"), h("td", {}, a.action), h("td", { class: "mono wrap" }, a.detail || "")))))));
}
