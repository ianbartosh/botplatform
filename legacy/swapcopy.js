#!/usr/bin/env node
/**
 * swapcopy.js — proportional SPOT copy-trader for one Solana wallet (USDC-based), via Jupiter Ultra.
 *
 * v1.0 (2026-10-03) — built for source FgCteMk5NCERqR4u2RWjfZ9SPA5kpw2yGnsPYMUQ8zyA on 2,500 USDC.
 *   How it copies:
 *   - Polls the source wallet's transactions. A tx where ONE token goes up and USDC/SOL goes down is a BUY;
 *     one token down and USDC/SOL up is a SELL. Airdrops, transfers and fee distributions are ignored.
 *   - BUY:  our size = his USD size x RATIO (x NEW_TOKEN_MULT for tokens younger than NEW_TOKEN_HOURS).
 *           Skipped if mcap < MIN_MCAP_USD, or our fill would be > PRICE_GUARD_PCT worse than his.
 *           Capped per token (MAX_PER_TOKEN_USD / MAX_PER_NEW_TOKEN_USD) and in total (MAX_EXPOSURE_USD).
 *           Slices below MIN_ORDER_USD are pooled per token and sent once they add up (expire after 30 min).
 *   - SELL: he sold X% of his bag -> we sell X% of ours (>=97% = sell everything). No stop-loss of our own.
 *   - All swaps USDC <-> token through Jupiter Ultra (gas handled by Ultra; keep ~0.05 SOL anyway).
 *   - On first boot it starts from the source's CURRENT tx: it never copies history.
 *   CLI:  node swapcopy.js --report      positions, realized PnL, NAV vs START_USD
 *         node swapcopy.js --sell-all    sell every copied position to USDC (stop the bot first)
 * v1.1 — polling no longer uses the RPC `until` cursor (Helius returned "failed to get signatures for
 *        address: Transaction …" when it couldn't resolve that signature, which stalls the poll); it reads
 *        the newest 50 signatures and skips the ones already processed.
 * v1.2 — adaptive polling to save Helius credits: every POLL_MS (3s) for ACTIVE_WINDOW_MIN (30) after his
 *        last trade, otherwise every POLL_IDLE_MS (20s). Heartbeat logs RPC calls and the ~per-day rate.
 */
"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bs58 = require("bs58");
const { Connection, Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");

const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => { const v = parseFloat(env(k, d)); return Number.isFinite(v) ? v : parseFloat(d); };
const CFG = {
  SOURCE: env("SOURCE_WALLET", "FgCteMk5NCERqR4u2RWjfZ9SPA5kpw2yGnsPYMUQ8zyA"),
  RPC_URL: env("RPC_URL", "https://api.mainnet-beta.solana.com"),
  JUP: env("JUP_BASE", "https://lite-api.jup.ag"),
  JUP_API_KEY: env("JUP_API_KEY", ""),
  DRY_RUN: env("DRY_RUN", "true").toLowerCase() !== "false",
  START_USD: num("START_USD", "2500"),
  RATIO: num("RATIO", "0.015"),                       // his $500 slice -> $7.50
  NEW_TOKEN_HOURS: num("NEW_TOKEN_HOURS", "24"),
  NEW_TOKEN_MULT: num("NEW_TOKEN_MULT", "0.5"),       // 0 = never copy tokens younger than NEW_TOKEN_HOURS
  MIN_MCAP_USD: num("MIN_MCAP_USD", "500000"),
  MAX_PER_TOKEN_USD: num("MAX_PER_TOKEN_USD", "400"),
  MAX_PER_NEW_TOKEN_USD: num("MAX_PER_NEW_TOKEN_USD", "150"),
  MAX_EXPOSURE_USD: num("MAX_EXPOSURE_USD", "1250"),  // total cost basis of open positions
  USDC_RESERVE: num("USDC_RESERVE", "25"),
  MIN_ORDER_USD: num("MIN_ORDER_USD", "5"),
  PRICE_GUARD_PCT: num("PRICE_GUARD_PCT", "3"),
  POLL_MS: num("POLL_MS", "3000"),                    // poll speed while he's actively trading
  POLL_IDLE_MS: num("POLL_IDLE_MS", "20000"),         // poll speed when he hasn't traded for ACTIVE_WINDOW_MIN
  ACTIVE_WINDOW_MIN: num("ACTIVE_WINDOW_MIN", "30"),
  MAX_LAG_SEC: num("MAX_LAG_SEC", "180"),             // ignore source trades older than this (catch-up after downtime)
  HEARTBEAT_MIN: num("HEARTBEAT_MIN", "30"),
  STATE_FILE: env("STATE_FILE", path.join(__dirname, "swapcopy_state.json")),
};
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const QUOTES = new Set([USDC, WSOL, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" /* USDT */]);
const SKIP_MINTS = new Set([...QUOTES, "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"]);

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
CFG.RPC_URL = String(CFG.RPC_URL).trim().replace(/^["']|["']$/g, "");   // tolerate quotes/spaces around the URL
if (!/^https?:\/\//i.test(CFG.RPC_URL)) {
  console.error(`RPC_URL in .env must be a full URL starting with https:// — it is currently "${CFG.RPC_URL.slice(0, 40)}${CFG.RPC_URL.length > 40 ? "…" : ""}".`);
  console.error(`Fix the RPC_URL line in ${path.join(__dirname, ".env")} (e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY), then: pm2 restart swapcopy`);
  setTimeout(() => process.exit(1), 60_000);                          // slow exit so pm2 doesn't spin
  return;
}
const conn = new Connection(CFG.RPC_URL, { commitment: "confirmed" });
let rpcCalls = 0, rpcSince = Date.now();               // v1.2: RPC usage counter (shown in the heartbeat)
const rpc = p => { rpcCalls++; return p; };
const SRC = new PublicKey(CFG.SOURCE);
let signer = null;
try {
  const k = env("PRIVATE_KEY", "").trim();
  if (k) signer = Keypair.fromSecretKey(k.startsWith("[") ? Uint8Array.from(JSON.parse(k)) : (bs58.decode ?? bs58.default.decode)(k));
} catch (e) { console.error("PRIVATE_KEY could not be read:", e.message); process.exit(1); }

// ---------- state ----------
let S = { lastSig: null, pos: {}, pending: {}, closed: [], stats: { buys: 0, sells: 0, skipped: {}, realized: 0, fees: 0 }, created: Date.now() };
try { S = { ...S, ...JSON.parse(fs.readFileSync(CFG.STATE_FILE, "utf8")) }; } catch {}
const save = () => { const t = CFG.STATE_FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(S, null, 1)); fs.renameSync(t, CFG.STATE_FILE); };
const skip = (why, msg) => { S.stats.skipped[why] = (S.stats.skipped[why] || 0) + 1; log(`  skip (${why}): ${msg}`); };

// ---------- Jupiter ----------
const jget = async (url, opts = {}) => {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(CFG.JUP_API_KEY ? { "x-api-key": CFG.JUP_API_KEY } : {}) } });
      if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
      return await r.json();
    } catch (e) { if (a === 2) throw e; await sleep(1000 * (a + 1)); }
  }
  return {};
};
const tokCache = {};
async function tokenInfo(mint) {
  const c = tokCache[mint];
  if (c && Date.now() - c.at < 5 * 60_000) return c.v;
  const r = await jget(`${CFG.JUP}/tokens/v2/search?query=${mint}`).catch(() => []);
  const t = (Array.isArray(r) ? r : []).find(x => x.id === mint) || null;
  tokCache[mint] = { at: Date.now(), v: t };
  return t;
}
async function solUsd() {
  const r = await jget(`${CFG.JUP}/price/v3?ids=${WSOL}`).catch(() => ({}));
  return +(r?.[WSOL]?.usdPrice || 0);
}
async function ultraOrder(inMint, outMint, amountRaw, withTaker = true) {
  const t = withTaker && signer ? `&taker=${signer.publicKey.toBase58()}` : "";
  return jget(`${CFG.JUP}/ultra/v1/order?inputMint=${inMint}&outputMint=${outMint}&amount=${amountRaw}${t}`);
}
async function ultraExecute(order) {
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([signer]);
  return jget(`${CFG.JUP}/ultra/v1/execute`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: order.requestId }),
  });
}

// ---------- wallet reads ----------
async function myTokenRaw(mint) {
  if (!signer) return 0n;
  const r = await rpc(conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) })).catch(() => null);
  let s = 0n; for (const a of r?.value || []) s += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return s;
}
async function myUsdc() { return signer ? Number(await myTokenRaw(USDC)) / 1e6 : CFG.START_USD; }

// ---------- parse one source tx into a trade ----------
// returns { side, mint, tokenUi, decimals, usd, preUi, postUi } or null
function parseTrade(tx, solPx) {
  if (!tx || tx.meta?.err) return null;
  const me = CFG.SOURCE, m = tx.meta;
  const keys = tx.transaction.message.accountKeys.map(k => (k.pubkey ? k.pubkey.toString() : k.toString()));
  const bal = arr => { const o = {}; for (const b of arr || []) if (b.owner === me) { const k = b.mint; o[k] = o[k] || { amt: 0n, dec: b.uiTokenAmount.decimals }; o[k].amt += BigInt(b.uiTokenAmount.amount); } return o; };
  const pre = bal(m.preTokenBalances), post = bal(m.postTokenBalances);
  const delta = {};
  for (const k of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    const d = (post[k]?.amt || 0n) - (pre[k]?.amt || 0n);
    if (d !== 0n) delta[k] = { d, dec: (post[k] || pre[k]).dec, pre: pre[k]?.amt || 0n, post: post[k]?.amt || 0n };
  }
  const i = keys.indexOf(me);
  const solD = i >= 0 ? (m.postBalances[i] - m.preBalances[i]) / 1e9 : 0;   // native SOL (fee payer is usually a relayer)
  let quoteUsd = 0;
  if (delta[USDC]) quoteUsd += Number(delta[USDC].d) / 1e6;
  if (delta["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]) quoteUsd += Number(delta["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"].d) / 1e6;
  let solQ = solD + (delta[WSOL] ? Number(delta[WSOL].d) / 1e9 : 0);
  if (Math.abs(solQ) > 0.01) quoteUsd += solQ * solPx;                       // ignore rent-sized SOL noise
  const toks = Object.entries(delta).filter(([k]) => !QUOTES.has(k));
  if (toks.length !== 1 || Math.abs(quoteUsd) < 1) return null;
  const [mint, t] = toks[0];
  if (SKIP_MINTS.has(mint)) return null;
  const ui = Number(t.d < 0n ? -t.d : t.d) / 10 ** t.dec;
  if (t.d > 0n && quoteUsd < 0) return { side: "buy", mint, tokenUi: ui, decimals: t.dec, usd: -quoteUsd, preUi: Number(t.pre) / 10 ** t.dec, postUi: Number(t.post) / 10 ** t.dec };
  if (t.d < 0n && quoteUsd > 0) return { side: "sell", mint, tokenUi: ui, decimals: t.dec, usd: quoteUsd, preUi: Number(t.pre) / 10 ** t.dec, postUi: Number(t.post) / 10 ** t.dec };
  return null;
}

// ---------- copy logic ----------
const exposure = () => Object.values(S.pos).reduce((a, p) => a + (p.cost || 0), 0);
async function copyBuy(tr, sigShort) {
  const info = await tokenInfo(tr.mint);
  const sym = info?.symbol || tr.mint.slice(0, 6);
  const ageH = info?.createdAt ? (Date.now() - Date.parse(info.createdAt)) / 3600e3 : null;
  const mcap = +(info?.mcap || info?.fdv || 0);
  const isNew = ageH == null || ageH < CFG.NEW_TOKEN_HOURS;
  log(`SOURCE BUY ${sym}: $${tr.usd.toFixed(0)} @ ${(tr.usd / tr.tokenUi).toPrecision(4)} | age ${ageH == null ? "?" : ageH.toFixed(1) + "h"} mcap $${(mcap / 1e6).toFixed(2)}M [${sigShort}]`);
  if (mcap && mcap < CFG.MIN_MCAP_USD) return skip("mcap", `${sym} mcap $${(mcap / 1e3).toFixed(0)}k < $${(CFG.MIN_MCAP_USD / 1e3).toFixed(0)}k`);
  if (!mcap) return skip("no-data", `${sym}: no Jupiter data (mcap/age unknown)`);
  const mult = isNew ? CFG.NEW_TOKEN_MULT : 1;
  if (mult <= 0) return skip("new-token", `${sym} is ${ageH == null ? "of unknown age" : ageH.toFixed(1) + "h old"}`);
  const cap = isNew ? CFG.MAX_PER_NEW_TOKEN_USD : CFG.MAX_PER_TOKEN_USD;
  const p = S.pos[tr.mint];
  let usd = tr.usd * CFG.RATIO * mult;
  usd = Math.min(usd, cap - (p?.cost || 0), CFG.MAX_EXPOSURE_USD - exposure());
  if (usd <= 0.01) return skip("cap", `${sym}: ${(p?.cost || 0) >= cap ? `per-token cap $${cap} reached` : `total exposure cap $${CFG.MAX_EXPOSURE_USD} reached`}`);
  // pool tiny slices
  const pend = S.pending[tr.mint];
  if (pend && Date.now() - pend.at > 30 * 60_000) delete S.pending[tr.mint];
  const total = usd + (S.pending[tr.mint]?.usd || 0);
  if (total < CFG.MIN_ORDER_USD) {
    S.pending[tr.mint] = { usd: total, at: S.pending[tr.mint]?.at || Date.now() }; save();
    return log(`  pooled $${usd.toFixed(2)} (pending $${total.toFixed(2)} < $${CFG.MIN_ORDER_USD} min order)`);
  }
  usd = Math.min(total, cap - (p?.cost || 0), CFG.MAX_EXPOSURE_USD - exposure());
  delete S.pending[tr.mint];
  const free = (await myUsdc()) - CFG.USDC_RESERVE;
  if (free < CFG.MIN_ORDER_USD) return skip("balance", `only $${free.toFixed(2)} USDC free`);
  usd = Math.min(usd, free);
  const raw = Math.floor(usd * 1e6);
  const order = await ultraOrder(USDC, tr.mint, raw, !CFG.DRY_RUN);
  if (!order || !order.outAmount) return skip("no-route", `${sym}: ${JSON.stringify(order).slice(0, 120)}`);
  const myPx = usd / (Number(order.outAmount) / 10 ** tr.decimals), hisPx = tr.usd / tr.tokenUi;
  const worse = (myPx / hisPx - 1) * 100;
  if (worse > CFG.PRICE_GUARD_PCT) return skip("price-guard", `${sym}: our price ${worse.toFixed(1)}% above his fill (> ${CFG.PRICE_GUARD_PCT}%)`);
  if (CFG.DRY_RUN) {
    log(`  [DRY_RUN] would BUY $${usd.toFixed(2)} of ${sym} (${worse >= 0 ? "+" : ""}${worse.toFixed(1)}% vs his price)`);
    const q = S.pos[tr.mint] || (S.pos[tr.mint] = { sym, cost: 0, proceeds: 0, tokens: 0, decimals: tr.decimals, first: Date.now(), isNew });
    q.cost += usd; q.tokens += Number(order.outAmount) / 10 ** tr.decimals; S.stats.buys++; save(); return;
  }
  const res = await ultraExecute(order);
  if (res.status !== "Success") return skip("exec-fail", `${sym}: ${JSON.stringify(res).slice(0, 150)}`);
  const spent = Number(res.inputAmountResult || res.totalInputAmount || raw) / 1e6;
  const got = Number(res.outputAmountResult || res.totalOutputAmount || order.outAmount) / 10 ** tr.decimals;
  const q = S.pos[tr.mint] || (S.pos[tr.mint] = { sym, cost: 0, proceeds: 0, tokens: 0, decimals: tr.decimals, first: Date.now(), isNew });
  q.cost += spent; q.tokens += got; q.last = Date.now(); S.stats.buys++;
  save();
  log(`  BOUGHT ${sym}: $${spent.toFixed(2)} -> ${got.toPrecision(5)} (${worse >= 0 ? "+" : ""}${worse.toFixed(1)}% vs his price) | ${sym} cost $${q.cost.toFixed(2)} | exposure $${exposure().toFixed(0)} | tx ${res.signature}`);
}

async function copySell(tr, sigShort) {
  const p = S.pos[tr.mint];
  const frac = tr.preUi > 0 ? Math.min(1, tr.tokenUi / tr.preUi) : 1;
  const sym = p?.sym || (await tokenInfo(tr.mint))?.symbol || tr.mint.slice(0, 6);
  log(`SOURCE SELL ${sym}: ${(frac * 100).toFixed(0)}% of his bag for $${tr.usd.toFixed(0)} [${sigShort}]`);
  if (S.pending[tr.mint]) { delete S.pending[tr.mint]; save(); }
  if (!p) return log(`  (we don't hold ${sym})`);
  const all = frac >= 0.97;
  let rawBal = CFG.DRY_RUN ? BigInt(Math.floor(p.tokens * 10 ** p.decimals)) : await myTokenRaw(tr.mint);
  if (rawBal === 0n) { log(`  no ${sym} left in wallet — closing the record`); return closePos(tr.mint, 0); }
  const sellRaw = all ? rawBal : (rawBal * BigInt(Math.round(frac * 10000))) / 10000n;
  if (sellRaw === 0n) return;
  const order = await ultraOrder(tr.mint, USDC, sellRaw.toString(), !CFG.DRY_RUN);
  if (!order || !order.outAmount) return skip("no-route", `${sym} sell: ${JSON.stringify(order).slice(0, 120)}`);
  const outUsd = Number(order.outAmount) / 1e6;
  const share = Number(sellRaw) / Number(rawBal);
  if (CFG.DRY_RUN) {
    log(`  [DRY_RUN] would SELL ${(share * 100).toFixed(0)}% of our ${sym} for ~$${outUsd.toFixed(2)}`);
    p.proceeds += outUsd; p.tokens -= Number(sellRaw) / 10 ** p.decimals; S.stats.sells++;
    if (all || p.tokens <= 0) return closePos(tr.mint, outUsd);
    save(); return;
  }
  const res = await ultraExecute(order);
  if (res.status !== "Success") return skip("exec-fail", `${sym} sell: ${JSON.stringify(res).slice(0, 150)}`);
  const got = Number(res.outputAmountResult || res.totalOutputAmount || order.outAmount) / 1e6;
  p.proceeds += got; p.tokens = Math.max(0, p.tokens - Number(sellRaw) / 10 ** p.decimals); p.last = Date.now(); S.stats.sells++;
  log(`  SOLD ${(share * 100).toFixed(0)}% of ${sym} for $${got.toFixed(2)} | tx ${res.signature}`);
  if (all) { await sleep(2500); const left = await myTokenRaw(tr.mint); if (left * 20n > rawBal) log(`  ${sym}: ${left} raw left after sell-all — next sell will retry`); else return closePos(tr.mint, got); }
  save();
}
function closePos(mint, lastOut) {
  const p = S.pos[mint]; if (!p) return;
  const pnl = p.proceeds - p.cost;
  S.stats.realized += pnl;
  S.closed.push({ mint, sym: p.sym, cost: +p.cost.toFixed(2), proceeds: +p.proceeds.toFixed(2), pnl: +pnl.toFixed(2), first: p.first, closed: Date.now(), isNew: p.isNew });
  if (S.closed.length > 2000) S.closed = S.closed.slice(-2000);
  delete S.pos[mint]; save();
  log(`  CLOSED ${p.sym}: cost $${p.cost.toFixed(2)} -> $${p.proceeds.toFixed(2)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | realized total ${S.stats.realized >= 0 ? "+" : ""}$${S.stats.realized.toFixed(2)}`);
}

// ---------- NAV / report ----------
async function nav() {
  const mints = Object.keys(S.pos);
  let px = {};
  for (let i = 0; i < mints.length; i += 50) Object.assign(px, await jget(`${CFG.JUP}/price/v3?ids=${mints.slice(i, i + 50).join(",")}`).catch(() => ({})));
  let tokVal = 0; const rows = [];
  for (const m of mints) {
    const p = S.pos[m];
    const amt = CFG.DRY_RUN || !signer ? p.tokens : Number(await myTokenRaw(m)) / 10 ** p.decimals;
    const v = amt * (+(px[m]?.usdPrice) || 0); tokVal += v;
    rows.push({ sym: p.sym, cost: p.cost, proceeds: p.proceeds, value: v, upnl: v + p.proceeds - p.cost });
  }
  const usdc = CFG.DRY_RUN || !signer ? CFG.START_USD - Object.values(S.pos).reduce((a, p) => a + p.cost - p.proceeds, 0) + S.stats.realized
                                      : await myUsdc();
  return { usdc, tokVal, total: usdc + tokVal, rows };
}
async function report() {
  const n = await nav();
  console.log(`\nswapcopy ${CFG.DRY_RUN ? "(DRY_RUN — paper numbers)" : ""} | source ${CFG.SOURCE.slice(0, 6)}… | ratio ${CFG.RATIO}`);
  console.log(`NAV $${n.total.toFixed(2)} = USDC $${n.usdc.toFixed(2)} + tokens $${n.tokVal.toFixed(2)} | vs start $${CFG.START_USD}: ${n.total - CFG.START_USD >= 0 ? "+" : ""}$${(n.total - CFG.START_USD).toFixed(2)} (${((n.total / CFG.START_USD - 1) * 100).toFixed(2)}%)`);
  console.log(`realized ${S.stats.realized >= 0 ? "+" : ""}$${S.stats.realized.toFixed(2)} on ${S.closed.length} closed | ${S.stats.buys} buys, ${S.stats.sells} sells | skipped: ${JSON.stringify(S.stats.skipped)}`);
  if (n.rows.length) { console.log("open:"); for (const r of n.rows.sort((a, b) => b.cost - a.cost)) console.log(`  ${r.sym.padEnd(10)} cost $${r.cost.toFixed(2).padStart(8)}  sold $${r.proceeds.toFixed(2).padStart(8)}  value $${r.value.toFixed(2).padStart(8)}  pnl ${r.upnl >= 0 ? "+" : ""}$${r.upnl.toFixed(2)}`); }
  const last = S.closed.slice(-10).reverse();
  if (last.length) { console.log("last closed:"); for (const c of last) console.log(`  ${new Date(c.closed + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ")} ${c.sym.padEnd(10)} $${c.cost.toFixed(2)} -> $${c.proceeds.toFixed(2)}  ${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}`); }
}

// ---------- main loop ----------
let busy = false, lastBeat = 0;
async function poll() {
  if (busy) return; busy = true;
  try {
    // v1.1: no `until` cursor (RPC nodes reject it when they can't find that signature -> "failed to get
    // signatures for address: Transaction … "). Always read the newest 50 and keep the ones we haven't seen.
    const all = await rpc(conn.getSignaturesForAddress(SRC, { limit: 50 }));
    S.recent = S.recent || [];
    if (!S.lastSig) {
      S.lastSig = all[0]?.signature || null; S.lastTime = all[0]?.blockTime || Math.floor(Date.now() / 1000);
      S.recent = all.map(x => x.signature); save();
      log(`start point set at the source's latest tx — copying from here on`); return;
    }
    const seen = new Set(S.recent);
    const sigs = [];
    for (const x of all) { if (x.signature === S.lastSig || seen.has(x.signature)) break; sigs.push(x); }
    if (!sigs.length) return;
    const solPx = await solUsd();
    for (const s of sigs.reverse()) {                  // oldest first
      S.lastSig = s.signature; S.lastTime = s.blockTime || S.lastTime;
      S.recent.unshift(s.signature); if (S.recent.length > 300) S.recent.length = 300;
      if (s.err) continue;
      if (s.blockTime && Date.now() / 1000 - s.blockTime > CFG.MAX_LAG_SEC) { save(); continue; }
      const tx = await rpc(conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })).catch(() => null);
      const tr = parseTrade(tx, solPx);
      if (tr) {
        S.lastTradeAt = Date.now();
        try { tr.side === "buy" ? await copyBuy(tr, s.signature.slice(0, 8)) : await copySell(tr, s.signature.slice(0, 8)); }
        catch (e) { log(`  copy error: ${(e.message || "").slice(0, 150)}`); }
      }
      save();
    }
  } catch (e) { log("poll error:", (e.message || "").slice(0, 120)); }
  finally {
    busy = false;
    if (Date.now() - lastBeat > CFG.HEARTBEAT_MIN * 60_000) {
      lastBeat = Date.now();
      const n = await nav().catch(() => null);
      const hrs = (Date.now() - rpcSince) / 3600e3, perDay = hrs > 0 ? rpcCalls / hrs * 24 : 0;
      const mode = Date.now() - (S.lastTradeAt || 0) < CFG.ACTIVE_WINDOW_MIN * 60_000 ? `active ${CFG.POLL_MS / 1000}s` : `idle ${CFG.POLL_IDLE_MS / 1000}s`;
      if (n && hrs > 0.1) log(`rpc: ${rpcCalls} calls in ${(hrs * 60).toFixed(0)} min (~${Math.round(perDay)}/day) | polling ${mode}`);
      rpcCalls = 0; rpcSince = Date.now();
      if (n) log(`heartbeat: NAV $${n.total.toFixed(2)} (${n.total - CFG.START_USD >= 0 ? "+" : ""}$${(n.total - CFG.START_USD).toFixed(2)}) | USDC $${n.usdc.toFixed(2)} | ${Object.keys(S.pos).length} open, exposure $${exposure().toFixed(0)} | realized ${S.stats.realized >= 0 ? "+" : ""}$${S.stats.realized.toFixed(2)}`);
    }
  }
}
async function sellAll() {
  for (const [mint, p] of Object.entries(S.pos)) {
    const raw = await myTokenRaw(mint);
    if (raw === 0n) { closePos(mint, 0); continue; }
    const o = await ultraOrder(mint, USDC, raw.toString());
    if (!o?.transaction) { log(`${p.sym}: no route`); continue; }
    const r = await ultraExecute(o);
    if (r.status === "Success") { p.proceeds += Number(r.outputAmountResult || o.outAmount) / 1e6; closePos(mint, 0); }
    else log(`${p.sym}: sell failed ${JSON.stringify(r).slice(0, 120)}`);
  }
}

if (require.main === module) (async () => {
  if (process.argv.includes("--report")) { await report(); process.exit(0); }
  if (process.argv.includes("--sell-all")) { if (!signer) { console.error("no PRIVATE_KEY"); process.exit(1); } await sellAll(); await report(); process.exit(0); }
  if (!CFG.DRY_RUN && !signer) { console.error("DRY_RUN=false needs PRIVATE_KEY in .env"); process.exit(1); }
  log(`swapcopy v1.2 | ${CFG.DRY_RUN ? "DRY_RUN (paper)" : "LIVE"} | source ${CFG.SOURCE} | wallet ${signer ? signer.publicKey.toBase58() : "(none)"}`);
  log(`sizing: ratio ${CFG.RATIO} (his $500 = $${(500 * CFG.RATIO).toFixed(2)}) | tokens < ${CFG.NEW_TOKEN_HOURS}h x${CFG.NEW_TOKEN_MULT}, cap $${CFG.MAX_PER_NEW_TOKEN_USD} | older cap $${CFG.MAX_PER_TOKEN_USD} | total cap $${CFG.MAX_EXPOSURE_USD} | mcap >= $${(CFG.MIN_MCAP_USD / 1e3).toFixed(0)}k | price guard ${CFG.PRICE_GUARD_PCT}% | min order $${CFG.MIN_ORDER_USD}`);
  if (signer && !CFG.DRY_RUN) { const sol = await conn.getBalance(signer.publicKey); log(`wallet: USDC $${(await myUsdc()).toFixed(2)} | SOL ${(sol / 1e9).toFixed(4)}${sol < 0.02e9 ? "  <-- add ~0.05 SOL for account rent" : ""}`); }
  // v1.2 adaptive polling: fast while he's trading, slow when he's quiet (most of the Bangkok day)
  const loop = async () => {
    await poll();
    const active = Date.now() - (S.lastTradeAt || 0) < CFG.ACTIVE_WINDOW_MIN * 60_000;
    setTimeout(loop, active ? CFG.POLL_MS : CFG.POLL_IDLE_MS);
  };
  loop();
})();

module.exports = { parseTrade, copyBuy, copySell, report, _state: () => S };
