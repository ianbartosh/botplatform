#!/usr/bin/env node
/**
 * copylp — mirrors DLMM LP wallets (not swap traders).
 *
 * VERSION HISTORY (bump BOT_VERSION below on every build; prints on boot and via `node copylp.js --version`)
 * 0.6.23 DUAL-LEG COPY. Per-target key extra=<shape><depth> (e.g. extra=bidask50, spot60, curve40) opens a
 *        SECOND position for every copied source position, same SOL size: that shape, from the top of
 *        the copied range (below price) down to <depth>% from price. Both legs share the source link
 *        (srcPos), so follow=source closes them together; each leg is its own ladder for stops. Entries
 *        carry leg = "src" | "bidask50" ... so the two legs can be compared in the state file. A failed
 *        extra leg never undoes the main leg.
 * 0.6.22 BASIS GUARD. A position that holds no token yet (pure SOL) can't really be down, but if part of
 *        the add never landed the recorded deposit is too high and the bot sees a fake loss — on 09-30 an
 *        Etedre Hg5Ja5 ladder showed -29.6% five minutes after opening (21.1 of 30 SOL actually in it), hit
 *        the hard stop and closed; chain result was -0.0002 SOL. The same bad deposit put -8.9 SOL of fake
 *        loss in the ledger's tracker column. Now: two reads 3+ min apart that agree -> deposit is reset to
 *        what is really in the position (logged as "basis fix"), so stops and the tracker use the true basis.
 * 0.6.21 (1) WALLET-TRUTH LEDGER (same engine as screenerlp v0.7.15). Every landed tx — mirror opens,
 *        adds, claims, trims, closes, Jupiter sells, WSOL unwraps, janitor sweeps/burns — is tagged to a
 *        "holding" (one target wallet's positions in one pool, first open -> last close) and read back
 *        from chain: signer SOL + WSOL change per tx. On close: tracker PnL (deposit x last pnl + trims)
 *        vs real wallet PnL, tx fees, new bin arrays (counted from accounts actually created), plus
 *        running totals overall, per target wallet, and screener-gate pass vs would-block. Signatures
 *        are recorded even when the send call times out (a tx can land after a timeout); never-landed
 *        txs resolve as 0. `node copylp.js --ledger-report` prints it. (2) Pump gate (MAX_PUMP_1H_PCT /
 *        MAX_PUMP_6H_PCT, default 0 = off; per-wallet pump=off): skip opens on tokens that already ran
 *        more than that % in the last 1h / 6h (Jupiter stats). SAPIJIJU 2026-09-29: $0.9M -> ~$5M in the
 *        hour the mirrors opened, then -80% in 4h (-11.2 SOL across two targets) — the $1M mcap gate
 *        passed it. (3) mcap gate: when Jupiter has no data for a token, falls back to Meteora's
 *        market_cap instead of skipping the gate.
 * 0.6.20 per-wallet churn override + churn count fix. `churn=off` (or churn=N) on a wallet in
 *        TARGET_WALLETS exempts that wallet's opens from MAX_OPENS_PER_MINT (or gives it its own cap) —
 *        for sources that re-open the same token on purpose (your own screener bots: legs, re-centers,
 *        upgrades). Its opens still count toward every other wallet's cap. The guard also counted each
 *        CHUNK of a wide mirror as a separate open, so one wide ladder could use the whole cap; it now
 *        counts one open per source position.
 * 0.6.19 LADDER CHUNK FIX. A mirror too wide for one position is split into chunk positions; each
 *        chunk used to be booked at an EQUAL share of the deposit and with the WHOLE ladder's bins.
 *        Shapes put very different SOL into each chunk, so chunks showed fake +/-PnL from the first
 *        second (a chunk could hit the hard line minutes after opening while the ladder was flat) and a
 *        chunk left behind by price could look "in range". Now each chunk's real deposit and bins are
 *        read from chain after opening; stops use the WHOLE ladder's pnl and close every chunk together;
 *        above-range uses the top of the chunks still open. Open chunk groups from older builds are
 *        repaired on boot (real bins; basis re-split by value, or = SOL held for untouched chunks).
 * 0.6.18 janitor dust cleanup. A retired token (no open position, no open in flight) whose leftover is
 *        dust (Jupiter quote < 0.002 SOL) gets its crumbs burned and its token account(s) closed in ONE
 *        transaction — reclaims the ~0.002 SOL rent per account, which is worth more than the dust.
 *        "No route" bags are never burned (could be real value) — re-checked daily instead of hourly.
 *        Cleaned tokens are remembered and skipped (no RPC) until the bot opens that token again; the
 *        Meteora SDK recreates the account automatically on the next open/withdraw. Also fixes empty
 *        Token-2022 accounts never closing (close ix was sent with the legacy token program id).
 * 0.6.17 screener gate over HTTP: SCREENER_GATE_FILE may be an http(s) URL (picks_server.js on the
 *        screener box), with SCREENER_GATE_TOKEN sent as the x-picks-token header. Fetched in the
 *        background every 30s, never blocks an open; a failed fetch keeps the last good copy and the
 *        normal staleness check (SCREENER_GATE_MAX_AGE_MIN) makes the gate step aside.
 * 0.6.16 screener gate (SCREENER_GATE, default off). Reads screener.js's screener_picks.json
 *        (SCREENER_GATE_FILE) before every mirror open. Modes: shadow = open as usual but record what
 *        the screener said and whether it WOULD have blocked; veto = block pools the screener marks
 *        SKIP-fading / SKIP-LPs leaving / GONE (2+ passes) (SCREENER_GATE_BLOCK_TIERS), plus an optional pace4h
 *        ceiling; strict = veto + block pools not listed at all. Stale/missing picks fail OPEN
 *        (copying never stops because the screener is down). Per-wallet override scr=off|shadow|veto|strict.
 *        Every new mirror stores m.scrTag; `node copylp.js --scr-report` summarizes results by tag.
 * 0.6.15 fee-spike de-risk (SPIKE_FEE_30M_PCT, default 0 = off). A position earning >= that % of
 *        its deposit per 30min is SPIKING — in the Sep 15-29 on-chain data that was usually a sell-off
 *        trading down through the ladder (338 positions: 123 ended below -5% for -222 SOL). Staged:
 *        (1) spike -> claim fees now + block new opens/adds on that pool while it stays hot;
 *        (2) spike + pnl <= SPIKE_TRIM_PNL (0%) -> withdraw SPIKE_TRIM_PCT (50%) once, sell it;
 *        (3) spike + pnl <= SPIKE_EXIT_PNL (-3%) -> close the rest. Fee rate is re-measured every
 *        SPIKE_CHECK_MIN on every open position while on. Trim keeps % pnl continuous (basis and
 *        fee baseline scale with the withdrawn share) and books the trimmed part in the ledger.
 * 0.6.14 hard-SL token cooldown: when the HARD collapse line closes a position, new opens on that
 *        mint are blocked for HARD_SL_COOLDOWN_MIN (default 60) across ALL wallets. Persisted in
 *        state (survives restarts). Also fixes the MAX_OPENS_PER_MINT churn guard, which compared
 *        against src.mint (undefined) and so never counted anything — now uses src.tokenX.
 * 0.6.13 GROUP_BUDGETS "res" suffix (e.g. stonk:27res): reserve-only group — N SOL stays held for
 *        the group (other wallets reserve around it, unchanged) but the group has NO ceiling and
 *        keeps following into genuinely free balance (other groups' reserves + SOL_RESERVE still
 *        protected). Third mode beside name:N (reserve+ceiling) and name:Ncap (ceiling-only).
 * 0.6.12 open-path resilience: transient RPC errors (Simulation failed / bad upstream / blockhash /
 *        429 / timeouts) retry in place up to 3x with land-check first; a terminal mirror ERROR
 *        un-marks `seen` so the position is re-attempted on later polls (4 attempts total) instead
 *        of being burned forever by one RPC hiccup. Gate skips are still final, as before.
 * 0.6.11 GROUP_BUDGETS "cap" suffix (e.g. bdrs:25cap): ceiling-only group — exposure still capped
 *        at N SOL, but the unspent budget is NOT reserved from other wallets' available balance.
 *        Plain name:N entries keep the v0.6.0 reservation+ceiling semantics.
 * 0.6.10 realtime nudge now honors the first-poll baseline: a never-polled target is baselined
 *        (all current positions marked seen, none copied) instead of mirroring its whole existing
 *        book when a wallet event races the first tick after the target is added.
 * 0.6.9  adds trigger is now datapi allTimeDeposits (fill-immune): price trading through bins
 *        changes a position's live SOL balance and was generating phantom add/trim events on chop.
 *        Deposits only move on real owner adds. Chain bin-diff is now shape/span-only, with a
 *        reconciliation fallback (diff far from deposit delta -> Spot across our span).
 * 0.6.8  CRITICAL adds fix: snapshot was positionLiquidity (raw Q64 share) -> delta ~9e19 "SOL"
 *        sized an add straight to the max= cap. Snapshot is now positionYAmount lamports (SOL side
 *        only — the side we deposit); implausible deltas re-baseline instead of trading. Stale
 *        old-unit snapshots self-heal via the negative-delta re-baseline path on first check.
 * 0.6.7  followAdds now honors GROUP_BUDGETS on both sides (own-group ceiling caps/skips the
 *        add; other groups' unspent budgets reserved out of balance headroom) — 0.6.6 adds bypassed both
 * 0.6.6  per-target adds=on: mirror source ADD-liquidity into already-copied positions (per-bin
 *        delta diffed against a stored snapshot, delta classified & mirrored with its own shape ->
 *        layered curves e.g. BidAsk open + Spot add). SOL-side only, clamped to our span, sized by
 *        pct, capped at max=. ADDS_MIN_SRC_SOL (default 1) is the source-growth trigger.
 * 0.6.5  per-target oorup=N + global FOLLOW_OOR_UP_MIN: OOR-up timer that closes even while
 *        follow=source would hold (pierces mirrorHold for the upside case only; below/age/SL gating unchanged)
 *   v0.6.4 (2026-09-09)  - TOKEN-2022 TRANSFER TAX gate. stonk.fun-style "reward mode" mints charge
 *                          1-3% on EVERY transfer, so a filled position pays it twice (withdraw from
 *                          vault, then sell) — ~6% of the token leg, entirely invisible in datapi PnL.
 *                          Cash-flow audit 2026-09-09: ~93 SOL of a reported +130 SOL was this tax.
 *                          MAX_TOKEN_TAX_BPS skips mints above a ceiling, TAX_SIZE_MULT downsizes
 *                          instead, per-target `tax=` overrides, and the tax now prints on every MIRROR.
 *   v0.6.3 (2026-09-08)  - SINGLE-INSTANCE LOCK on the state file (pid + 30s heartbeat). A second
 *                          process on the same folder refuses to boot instead of silently
 *                          clobbering the ledger — a pm2 ghost fork (pid 7620, alive 7:19am-6pm)
 *                          was overwriting matt's ledger, so every just-opened position was
 *                          re-detected as an orphan and auto-closed by ORPHAN_POLICY=close.
 *                          CLI closes and --version bypass; LOCK_OVERRIDE=1 forces past a lock.
 *   v0.6.2 (2026-09-08)  - wide-path slippage retry fix: 0x1774 raised by the multi-position BUILDER
 *                          (compute-unit estimation) never retried, because `cleanFailure` is only
 *                          set in the chunk loop. Build-stage failures are clean by definition —
 *                          nothing is on-chain — so they now retry with doubled tolerance like the
 *                          narrow path. This was silently blocking every wide open.
 *   v0.6.1 (2026-09-08)  - in-flight lock on source positions: the same source position arriving
 *                          via realtime WS and poll backfill within milliseconds could pass the
 *                          seen-check twice and open two mirrors (both then orphaned). One mirror
 *                          attempt per source position at a time, released on completion.
 *   v0.6.0 (2026-09-06)  - GROUP_BUDGETS are now reservation + ceiling: a group's unused budget is
 *                          fenced off from non-members (their balance-aware sizing subtracts every
 *                          other group's unspent reserve), so grouped wallets always have their
 *                          allocation available. Members are unaffected by their own group's reserve.
 *   v0.5.4 (2026-09-03) - ORPHAN_POLICY=close|manage, ORPHAN_MAX_AGE_H, ORPHAN_TP_PCT — orphans
 *                        (sweep-adopted, no linkage) can be auto-closed on adoption, aged out,
 *                        or take-profited, instead of relying on SL/OOR alone
 *   v0.5.3 (2026-09-03) - PENDING-CHUNK REGISTRY: every generated position keypair is registered
 *                        with its source linkage before send; the orphan sweep adopts registry
 *                        hits WITH linkage ("LATE CHUNK adopted WITH linkage") and backfills
 *                        linkage on earlier target-less adoptions. Husk cleanup: an existing
 *                        account is ALWAYS recorded (only a reclaimed empty husk is a clean
 *                        failure); every branch logs. Record step always (re)writes linkage
 *                        (old `||` kept a sweep-adopted target=null entry -> silent orphan).
 *   v0.5.2 (2026-09-03) - wide-path husk cleanup gets the vanish-vs-transport discipline: raw
 *                        account polled 3x over ~6s; only explicit not-found allows rebuild;
 *                        an existing account is ALWAYS recorded with linkage even when the
 *                        parsed read glitches; unknown state -> no rebuild, no double-size
 *                        (fixes fast/wide opens orphaning in hot pools, 2026-09-02 evening)
 *   v0.5.1 (2026-09-02) - closeMine: transport/RPC errors ABORT the close instead of being
 *                        treated as "position vanished" — only an explicit account-not-found
 *                        marks a position closed without withdrawing (proxy-outage safety)
 *   v0.5 (2026-09-02)  - RPC_URL env override (point at rpcproxy on 127.0.0.1:8899 for a cache
 *                        shared across all bot instances); WS stays direct to Helius
 *   v0.4 (2026-09-01)  - GROUP_BUDGETS values are now plain SOL (fast:80 = 80 SOL cap), not percent
 *   v0.3 (2026-09-01)  - budget groups: per-target group=<name> + GROUP_BUDGETS caps a group's
 *                        combined open exposure; opens downsize into headroom, skip when full
 *   v0.2 (2026-09-01)  - per-target gate overrides: age= mcap= jup= feetvl= (0 = that gate off for the
 *                        wallet only) and width=source (exact ladder mirror, no width floor / depth
 *                        extension) — lets a launch-day specialist run inside a conservative global config
 *   v0.1 (2026-09-01)  - priority fee on open/chunk/husk txs (previously closes only)
 *                      - late-land reconciliation: opens that land after a confirmation
 *                        timeout are recorded with target/srcPos linkage instead of being
 *                        abandoned to the orphan sweep; wide ladders continue past a
 *                        late-landing chunk rather than aborting
 *                      - 2.5s TTL read cache on getAccountInfo/getMultipleAccountsInfo
 *                        (READ_CACHE_MS, 0 = off)
 *                      - fast-guard reuses WS-pushed activeId when <15s old instead of an
 *                        RPC read per danger pool per pass (LB_FRESH_MS, 0 = off)
 *                      - hourly "rpc reads:" budget line in the log
 *
 * Detection : Meteora datapi /portfolio/open per target wallet, polled every
 *             POLL_SECONDS (free HTTP — zero Helius credits for monitoring).
 * Copies    : ONLY single-sided SOL positions (bid-side liquidity below price)
 *             with target deposit >= MIN_TARGET_DEPOSIT_SOL. Mirrors the exact
 *             bin range, BidAsk shape, sized by ratio or fixed SOL.
 * Exits     : (1) source wallet closes their position -> we close ours
 *             (2) stop-loss: our position PnL <= -STOP_LOSS_PCT
 *             (3) fully filled + out of range below for AUTO_CLOSE_OOR_MIN
 *             Any tokens held at close are market-sold via Jupiter Ultra.
 *
 * SAFETY: DRY_RUN=true by default.
 */

"use strict";
require("dotenv").config?.();
const fs = require("fs");
const path = require("path");
const bs58 = require("bs58");
const WebSocket = require("ws");
const BN = require("bn.js");
const {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction: _sendAndConfirmRaw, VersionedTransaction, Transaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const DLMMPkg = require("@meteora-ag/dlmm");
const DLMM = DLMMPkg.default ?? DLMMPkg;
const { StrategyType, decodeAccount, getPriceOfBinByBinId } = DLMMPkg;

const BOT_VERSION = "0.6.23";
const { AsyncLocalStorage } = require("async_hooks");

// ===== v0.6.21 wallet-truth ledger ======================================================================
// A "holding" = one target's positions in one pool, from first open until its last position there closes.
const LEDGER_CTX = new AsyncLocalStorage();
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BINARRAY_RENT_SOL = 0.0714;            // rent-exempt minimum of one 70-bin DLMM bin array (~10.1 kB)
const lkey = (pool, target) => pool + "|" + (target || "?");
function wlState() {
  S.wl = S.wl || {};
  if (S.wl.ver !== 3) {                      // fresh start for this engine (an older ledger's data is kept aside)
    if (S.wl.eps || S.wl.totals) S.wl = { old: { totals: S.wl.totals, byTarget: S.wl.byTarget } };
    S.wl.ver = 3;
  }
  S.wl.eps = S.wl.eps || {}; S.wl.active = S.wl.active || {}; S.wl.pending = S.wl.pending || [];
  S.wl.misc = S.wl.misc || 0;
  S.wl.totals = S.wl.totals || { holdings: 0, trackerSol: 0, walletSol: 0, feeSol: 0, binArrays: 0, depositSol: 0 };
  S.wl.byTarget = S.wl.byTarget || {};
  S.wl.byFlag = S.wl.byFlag || { pass: { n: 0, trackerSol: 0, walletSol: 0, depositSol: 0 }, wouldBlock: { n: 0, trackerSol: 0, walletSol: 0, depositSol: 0 } };
  return S.wl;
}
function wlEpisodeFor(ctx, create) {
  const W = wlState();
  if (ctx.pool) {
    const k = lkey(ctx.pool, ctx.target);
    let id = W.active[k];
    if (!id && create) {
      id = k + ":" + Date.now();
      W.eps[id] = { key: k, pool: ctx.pool, target: ctx.target || null, mint: ctx.mint || null, sym: (ctx.mint || ctx.pool).slice(0, 6),
        start: Date.now(), end: null, partial: !ctx.open, flags: [...new Set(ctx.flags || [])],
        sigs: 0, resolved: 0, walletLamports: 0, feeLamports: 0, binArrays: 0, trackerSol: 0, depositSol: 0, done: false };
      W.active[k] = id;
    } else if (id && ctx.flags && ctx.flags.length) W.eps[id].flags = [...new Set([...(W.eps[id].flags || []), ...ctx.flags])];
    return id || null;
  }
  if (ctx.mint) {                            // sells without a pool (janitor, coalesced burst sell): latest holding of that token
    let best = null;
    for (const [id, e] of Object.entries(W.eps)) if (e.mint === ctx.mint && (!best || e.start > W.eps[best].start)) best = id;
    return best;
  }
  return null;
}
function ledgerRun(ctx, fn) { return LEDGER_CTX.run(ctx, fn); }
const _recorded = new Set();
function ledgerRecord(sig, unconfirmed = false) {
  if (!sig || typeof sig !== "string" || _recorded.has(sig)) return;
  _recorded.add(sig); if (_recorded.size > 5000) _recorded.clear();
  try {
    const W = wlState();
    const id = wlEpisodeFor(LEDGER_CTX.getStore() || {}, true);
    W.pending.push({ sig, id: id || "misc", t: Date.now(), tries: 0, unconfirmed });
    if (id && W.eps[id]) W.eps[id].sigs++;
  } catch {}
}
// record the signature even when the send/confirm call throws: a timeout does NOT mean the tx didn't land
const _b58 = (u8) => (bs58.encode ?? bs58.default.encode)(Buffer.from(u8));
function sigOfTx(tx) {
  try {
    if (tx && Array.isArray(tx.signatures) && tx.signatures.length && tx.signatures[0] instanceof Uint8Array) return _b58(tx.signatures[0]); // VersionedTransaction
    if (tx && tx.signature) return _b58(tx.signature);                                                                                         // legacy Transaction
  } catch {}
  return null;
}
async function sendAndConfirmTransaction(...a) {
  try {
    const sig = await _sendAndConfirmRaw(...a);
    ledgerRecord(sig);
    return sig;
  } catch (e) {
    const sig = (e && typeof e.signature === "string" && e.signature) || sigOfTx(a[1]);
    if (sig) ledgerRecord(sig, true);
    throw e;
  }
}
function ledgerTrackerAdd(m, pnlSol) {
  try {
    const W = wlState(); const id = W.active[lkey(m.pool, m.target)];
    if (id && W.eps[id] && Number.isFinite(pnlSol)) W.eps[id].trackerSol += pnlSol;
  } catch {}
}
function ledgerEndIfFlat(m) {
  const W = wlState(); const k = lkey(m.pool, m.target); const id = W.active[k];
  if (!id) return;
  const liveLeft = Object.values(S.mine).some(x => !x.closed && x.pool === m.pool && (x.target || "?") === (m.target || "?"));
  if (!liveLeft) { W.eps[id].end = Date.now(); delete W.active[k]; save(); }
}
const fmtS = v => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
const pctOf = (v, d) => d > 0 ? ` (${v >= 0 ? "+" : ""}${(100 * v / d).toFixed(2)}%)` : "";
function ledgerTotalsLine() {
  const T = wlState().totals;
  if (!T.holdings) return "";
  return `${T.holdings} closed holding(s): tracker ${fmtS(T.trackerSol)} SOL | wallet ${fmtS(T.walletSol)} SOL${pctOf(T.walletSol, T.depositSol)} on ${T.depositSol.toFixed(1)} SOL` +
    ` | gap ${fmtS(T.walletSol - T.trackerSol)} SOL | tx fees ${T.feeSol.toFixed(3)} | new bin arrays ${T.binArrays} (~${(T.binArrays * BINARRAY_RENT_SOL).toFixed(3)} SOL kept by chain)`;
}
function ledgerGateLine() {
  const F = wlState().byFlag;
  if (!F.pass.n && !F.wouldBlock.n) return "";
  const f = x => `${x.n} holding(s) wallet ${fmtS(x.walletSol)} SOL${pctOf(x.walletSol, x.depositSol)}`;
  return `screener gate — pass: ${f(F.pass)} | would-block: ${f(F.wouldBlock)}`;
}
let _ledgerBusy = false;
async function ledgerWorker() {
  if (_ledgerBusy || !signer) return;
  _ledgerBusy = true;
  try {
    const W = wlState();
    const me = signer.publicKey.toBase58();
    const keep = [];
    for (const it of W.pending.splice(0, 25)) {
      if (Date.now() - it.t < 5000) { keep.push(it); continue; }
      const tx = await conn.getTransaction(it.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => undefined);
      if (!tx || !tx.meta) {
        if (++it.tries < 40) { keep.push(it); continue; }
        const e0 = it.id !== "misc" ? W.eps[it.id] : null; if (e0) e0.resolved++;   // never landed: resolve as 0
        if (!it.unconfirmed) log(`  [LEDGER] gave up reading ${it.sig.slice(0, 10)}… — counted as not landed`);
        continue;
      }
      if (it.unconfirmed) log(`  [LEDGER] tx ${it.sig.slice(0, 10)}… timed out at send but LANDED on chain — counted`);
      const meta = tx.meta, msg = tx.transaction.message;
      const keys = (msg.staticAccountKeys || msg.accountKeys || []).map(k => (k.toBase58 ? k.toBase58() : String(k)));
      const idx = Math.max(0, keys.indexOf(me));
      const native = (meta.postBalances[idx] || 0) - (meta.preBalances[idx] || 0);
      const wsolOf = arr => (arr || []).filter(b => b.owner === me && b.mint === WSOL_MINT).reduce((a, b) => a + Number(b.uiTokenAmount.amount || 0), 0);
      const lam = native + (wsolOf(meta.postTokenBalances) - wsolOf(meta.preTokenBalances));
      // bin arrays actually CREATED in this tx (0 lamports -> bin-array rent); the InitializeBinArray log line
      // also appears when the array already exists, so it is not counted on its own
      const nArr = (meta.logMessages || []).some(l => /Instruction: InitializeBinArray/.test(l))
        ? (meta.preBalances || []).filter((pre, i) => pre === 0 && (meta.postBalances[i] || 0) >= 70_500_000 && (meta.postBalances[i] || 0) <= 73_000_000).length : 0;
      const e = it.id !== "misc" ? W.eps[it.id] : null;
      if (!e) { W.misc += lam; continue; }
      e.walletLamports += lam; e.feeLamports += idx === 0 ? (meta.fee || 0) : 0; e.binArrays += nArr; e.resolved++;
      if (nArr > 0) log(`  [LEDGER] ${e.sym}${e.target ? " [" + e.target.slice(0, 6) + "]" : ""}: tx created ${nArr} new bin array(s) — ~${(nArr * BINARRAY_RENT_SOL).toFixed(3)} SOL non-refundable`);
    }
    W.pending.unshift(...keep);
    for (const [id, e] of Object.entries(W.eps)) {
      if (e.done || !e.end || e.resolved < e.sigs) continue;
      if (Date.now() - e.end < 90_000) continue;             // let the exit sell / unwrap land first
      e.done = true;
      const wal = e.walletLamports / 1e9, fee = e.feeLamports / 1e9, hrs = (e.end - e.start) / 3600e3;
      const tg = e.target ? e.target.slice(0, 6) : "?";
      log(`  [LEDGER] [${tg}] ${e.sym} holding closed after ${hrs.toFixed(1)}h${e.partial ? " [partial: opened before the ledger started — not in totals]" : ""}${e.flags && e.flags.length ? " [screener gate would block]" : ""}: ` +
          `tracker ${fmtS(e.trackerSol)} SOL${pctOf(e.trackerSol, e.depositSol)} | wallet ${fmtS(wal)} SOL${pctOf(wal, e.depositSol)} | gap ${fmtS(wal - e.trackerSol)} SOL | ` +
          `tx fees ${fee.toFixed(4)} | new bin arrays ${e.binArrays} (~${(e.binArrays * BINARRAY_RENT_SOL).toFixed(3)} SOL)`);
      if (!e.partial) {
        const T = W.totals;
        T.holdings++; T.trackerSol += e.trackerSol; T.walletSol += wal; T.feeSol += fee; T.binArrays += e.binArrays; T.depositSol += e.depositSol;
        const bt = (W.byTarget[tg] = W.byTarget[tg] || { n: 0, wins: 0, trackerSol: 0, walletSol: 0, depositSol: 0 });
        bt.n++; if (wal > 0) bt.wins++; bt.trackerSol += e.trackerSol; bt.walletSol += wal; bt.depositSol += e.depositSol;
        const bf = W.byFlag[e.flags && e.flags.length ? "wouldBlock" : "pass"];
        bf.n++; bf.trackerSol += e.trackerSol; bf.walletSol += wal; bf.depositSol += e.depositSol;
        log(`  [LEDGER] totals — ${ledgerTotalsLine()}`);
        log(`  [LEDGER] [${tg}] target totals — ${bt.n} holding(s), ${bt.wins} wins: wallet ${fmtS(bt.walletSol)} SOL${pctOf(bt.walletSol, bt.depositSol)} | tracker ${fmtS(bt.trackerSol)}`);
      }
    }
    const doneIds = Object.entries(W.eps).filter(([, e]) => e.done).sort((a, b) => b[1].end - a[1].end).map(([id]) => id);
    for (const id of doneIds.slice(400)) delete W.eps[id];
    save();
  } catch (e) { log("  [LEDGER] worker error:", (e.message || "").slice(0, 80)); }
  finally { _ledgerBusy = false; }
}
// ======================================================================================================
const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);
const CFG = {
HELIUS_API_KEY: env("HELIUS_API_KEY", ""),
  RPC_URL: env("RPC_URL", ""),
  PRIVATE_KEY    : env("PRIVATE_KEY", ""),
  DRY_RUN        : env("DRY_RUN", "true") !== "false",
  TARGET_WALLETS : env("TARGET_WALLETS", ""),              // comma list of LP wallets to mirror

  POLL_SECONDS           : parseFloat(env("POLL_SECONDS", "60")),
  COPY_MODE              : env("COPY_MODE", "ratio"),      // "ratio" (% of their size) or "fixed" (SOL per position)
  COPY_RATIO_PCT         : parseFloat(env("COPY_RATIO_PCT", "10")),  // if ratio: our SOL = theirs * this %
  COPY_FIXED_SOL         : parseFloat(env("COPY_FIXED_SOL", "1")),   // if fixed: this much SOL every position
  MAX_COPY_SOL           : parseFloat(env("MAX_COPY_SOL", "5")),     // hard cap per position either mode
  MIN_TARGET_DEPOSIT_SOL : parseFloat(env("MIN_TARGET_DEPOSIT_SOL", "10")), // ignore their positions under this
  MAX_POS_PER_WALLET     : parseInt(env("MAX_POS_PER_WALLET", "10"), 10),
  MAX_POS_PER_TOKEN_PER_WALLET : parseInt(env("MAX_POS_PER_TOKEN_PER_WALLET", "2"), 10), // concurrent mirrors of one ticker from one source wallet
  MAX_POS_PER_TOKEN_GLOBAL     : parseInt(env("MAX_POS_PER_TOKEN_GLOBAL", "0"), 10),     // same, across ALL wallets; 0 disables
  MAX_OPENS_PER_MINT           : parseInt(env("MAX_OPENS_PER_MINT", "0"), 10),           // rate limit: max opens per mint per window, ALL wallets, counts closed reopens too; 0 disables
  MINT_OPEN_WINDOW_MIN         : parseFloat(env("MINT_OPEN_WINDOW_MIN", "60")),          // rolling window (minutes) for MAX_OPENS_PER_MINT
  MAX_GLOBAL_POSITIONS   : parseInt(env("MAX_GLOBAL_POSITIONS", "80"), 10),

  MIN_JUP_SCORE      : parseFloat(env("MIN_JUP_SCORE", "60")),
  MIN_MCAP_USD       : parseFloat(env("MIN_MCAP_USD", "1000000")),
  // TOKEN-2022 TRANSFER TAX (stonk.fun "reward mode" and similar): charged on EVERY transfer, so a
  // filled position pays it TWICE — once withdrawing tokens from the pool vault, once selling them.
  // At 3% that is ~6% of the token leg before pool swap fees, and it is invisible in datapi PnL.
  // Measured 2026-09-09: ~93 SOL of a reported +130 SOL was this tax. 0 = gate off.
  MAX_TOKEN_TAX_BPS  : parseFloat(env("MAX_TOKEN_TAX_BPS", "0")),      // skip mints taxed above this
  MAX_PUMP_1H_PCT    : parseFloat(env("MAX_PUMP_1H_PCT", "0")),         // v0.6.21 skip tokens up more than this % in 1h (0 = off)
  MAX_PUMP_6H_PCT    : parseFloat(env("MAX_PUMP_6H_PCT", "0")),         // v0.6.21 skip tokens up more than this % in 6h (0 = off)
  TAX_SIZE_MULT      : parseFloat(env("TAX_SIZE_MULT", "0")),          // >0: instead of skipping, size taxed mints at this multiple
  MIN_TOKEN_AGE_H    : parseFloat(env("MIN_TOKEN_AGE_H", "48")),
  // AGE_ALLOWLIST: "mint" or "mint:solmax" pairs, comma-separated. Listed mints are exempt
  // from the age gate ONLY (all other gates still apply); the optional :solmax caps total SOL
  // exposure in that mint (takes the LOWER of this and MAX_MINT_SOL). e.g. "6Heb...abc:15"
  AGE_ALLOWLIST      : Object.fromEntries(env("AGE_ALLOWLIST", "").split(",").map(s => s.trim()).filter(Boolean)
                         .map(s => { const [m, cap] = s.split(":"); return [m, cap ? parseFloat(cap) : null]; })),
  MIN_PRICE_RANGE_PCT: parseFloat(env("MIN_PRICE_RANGE_PCT", "3")),  // legacy floor, superseded by the tiered width gate below
  MIN_WIDTH_PCT        : parseFloat(env("MIN_WIDTH_PCT", "45")),        // min ladder width for all mirrors (7d data: <45% wide lost money in every mcap tier)
  MIN_WIDTH_LOWCAP_PCT : parseFloat(env("MIN_WIDTH_LOWCAP_PCT", "60")), // stricter floor for small caps — their vol whips through anything narrower
  MIN_WIDTH_MCAP_USD   : parseFloat(env("MIN_WIDTH_MCAP_USD", "2000000")), // the small-cap boundary for the stricter floor
  MAX_WIDEN_BINS       : parseFloat(env("MAX_WIDEN_BINS", "350")),          // sanity cap on ladder extension (tiny-binstep pools would need absurd bin counts)
  MIN_RANGE_DEPTH_PCT: parseFloat(env("MIN_RANGE_DEPTH_PCT", "40")), // our copy reaches at least this far below CURRENT price; deeper sources copied as-is
  MIN_FEE_TVL_24H_PCT: parseFloat(env("MIN_FEE_TVL_24H_PCT", "0.35")), // pool must earn this % of TVL in fees per 24h; 0 disables
  AUTOPAUSE_AFTER    : parseInt(env("AUTOPAUSE_AFTER", "0"), 10),      // 0 = manual pausing only (market-wide drawdowns redden every wallet; skill judgment stays human)
  PAUSED_TARGETS     : env("PAUSED_TARGETS", "").split(",").map(s => s.trim()).filter(Boolean), // manual pause list
  IGNORED_MINTS      : env("IGNORED_MINTS", "").split(",").map(s => s.trim()).filter(Boolean),

  STOP_LOSS_PCT      : parseFloat(env("STOP_LOSS_PCT", "8")),    // close ours at this fee-inclusive PnL breach
  SL_CONFIRM_SECONDS : parseFloat(env("SL_CONFIRM_SECONDS", "10")), // IN-RANGE breaches must persist this long before closing (wick filter; 0 = off)
  IN_RANGE_HARD_SL_PCT : parseFloat(env("IN_RANGE_HARD_SL_PCT", "13")), // hard collapse line: close immediately, no confirmation, no patience
  HOT_FEE_30M_PCT    : parseFloat(env("HOT_FEE_30M_PCT", "0.15")),
  // ---- screener gate (0.6.16). SCREENER_GATE=off|shadow|veto|strict (per-wallet scr= overrides)
  SCREENER_GATE          : env("SCREENER_GATE", "off").toLowerCase(),
  SCREENER_GATE_FILE     : env("SCREENER_GATE_FILE", ""),             // local path to screener_picks.json, OR http(s)://host:port/picks (picks_server.js)
  SCREENER_GATE_TOKEN    : env("SCREENER_GATE_TOKEN", ""),            // shared secret for the http(s) form (must match picks_server_settings.json)
  SCREENER_GATE_MAX_AGE_MIN: parseFloat(env("SCREENER_GATE_MAX_AGE_MIN", "30")), // older picks = screener down -> gate steps aside (fail open)
  SCREENER_GATE_BLOCK_TIERS: env("SCREENER_GATE_BLOCK_TIERS", "SKIP-fading,SKIP-LPs leaving,GONE"), // "SKIP-too slow" left out on purpose: slow pools were fine for copy targets in the Sep data
  SCREENER_GATE_MAX_PACE : parseFloat(env("SCREENER_GATE_MAX_PACE", "0")), // also block listed pools with pace4h above this %/day (0 = off)
  // ---- fee-spike de-risk (0.6.15). SPIKE_FEE_30M_PCT=0 turns the whole feature off.
  SPIKE_FEE_30M_PCT  : parseFloat(env("SPIKE_FEE_30M_PCT", "0")),     // spiking when earning >= this % of deposit per 30min (0.8 ~ 38%/day)
  SPIKE_TRIM_PNL     : parseFloat(env("SPIKE_TRIM_PNL", "0")),        // stage 2: while spiking and pnl <= this %, trim once
  SPIKE_TRIM_PCT     : parseFloat(env("SPIKE_TRIM_PCT", "50")),       // share of the position withdrawn + sold on the trim (0 = no trim stage)
  SPIKE_TRIM_MIN_SOL : parseFloat(env("SPIKE_TRIM_MIN_SOL", "0.5")),  // don't trim positions smaller than this (claim/exit still apply)
  SPIKE_EXIT_PNL     : parseFloat(env("SPIKE_EXIT_PNL", "-3")),       // stage 3: while spiking and pnl <= this %, close the position
  SPIKE_CLAIM_MIN_SOL: parseFloat(env("SPIKE_CLAIM_MIN_SOL", "0.05")),// stage 1: claim on spike when unclaimed >= this (normal claims use FEE_CLAIM_MIN_SOL)
  SPIKE_CHECK_MIN    : parseFloat(env("SPIKE_CHECK_MIN", "5")),       // re-measure fee rate on every open position at least this often
  SPIKE_BLOCK_MIN    : parseFloat(env("SPIKE_BLOCK_MIN", "30")),      // pool stays blocked for opens/adds this long after its last spiking reading
  SPIKE_MIN_WINDOW_MIN: parseFloat(env("SPIKE_MIN_WINDOW_MIN", "5")), // ignore fee-rate readings measured over a shorter window (1-min reads extrapolate noise x30)  // position counts as HOT when earning >= this % of deposit per 30min (0 = hot logic off)
  STOP_LOSS_HOT_PCT  : parseFloat(env("STOP_LOSS_HOT_PCT", "12")),  // stop line while HOT (fees actively paying for the drawdown)
  // ORPHAN POLICY — positions the sweep adopted with NO source linkage (registry miss = not one of ours):
  //   ORPHAN_POLICY=manage (default) -> exit-managed by SL/OOR/age like before, plus the two knobs below
  //   ORPHAN_POLICY=close           -> closed automatically on the first exit tick after adoption+enrichment
  ORPHAN_POLICY      : env("ORPHAN_POLICY", "manage"),
  ORPHAN_MAX_AGE_H   : parseFloat(env("ORPHAN_MAX_AGE_H", "0")),   // manage mode: close orphans older than N hours (0 off)
  ORPHAN_TP_PCT      : parseFloat(env("ORPHAN_TP_PCT", "0")),      // manage mode: close orphans once pnl >= N% (0 off)
  FEE_CLAIM_HOURS    : parseFloat(env("FEE_CLAIM_HOURS", "1")),  // check each position's fees at most this often; 0 = only at close
  TSL_ACTIVATE_PCT   : parseFloat(env("TSL_ACTIVATE_PCT", "0")), // DORMANT: trailing stop arms once PnL >= this %; 0 = tracking only
  TSL_DISTANCE_PCT   : parseFloat(env("TSL_DISTANCE_PCT", "7")), // close when PnL falls this far below its peak (only if activated)
  FEE_CLAIM_MIN_SOL  : parseFloat(env("FEE_CLAIM_MIN_SOL", "0.25")), // claim when a position's unclaimed fees reach this (SOL equivalent)
  WIDE_SLIPPAGE_PCT  : parseFloat(env("WIDE_SLIPPAGE_PCT", "5")),  // active-bin slippage tolerance (%) for wide multi-position opens; doubles per retry on 0x1774
  JANITOR_MIN        : parseFloat(env("JANITOR_MIN", "60")),       // minutes between wallet sweeps of leftover meme crumbs (0 = disabled)
  PNL_DEPTH_TRIGGER  : parseFloat(env("PNL_DEPTH_TRIGGER", "0.4")),// chain pnl check when price is this far down our ladder (0=top 1=bottom)
  PNL_CHECK_SECONDS  : parseFloat(env("PNL_CHECK_SECONDS", "60")), // min seconds between chain pnl checks per position while triggered
  PNL_HEARTBEAT_MIN  : parseFloat(env("PNL_HEARTBEAT_MIN", "60")), // force a chain pnl check at least this often regardless of triggers
  FAST_POLL_SECONDS  : parseFloat(env("FAST_POLL_SECONDS", "10")), // fast-guard cadence on danger pools (0 = disabled)
  GUARD_MOVE_BINS    : parseFloat(env("GUARD_MOVE_BINS", "3")),    // price move (bins) since last check that overrides the comfort backoff
  PRIORITY_FEE_MICRO : parseFloat(env("PRIORITY_FEE_MICRO", "150000")), // microlamports/CU on close txs (~0.00003 SOL/tx; 0 = disabled)
  AUTO_CLOSE_OOR_MIN : parseFloat(env("AUTO_CLOSE_OOR_MIN", "0")),  // 0 = IMMEDIATE close when fully filled below range; >0 = minutes timer; <0 = disabled
  AUTO_CLOSE_OOR_UP_MIN : parseFloat(env("AUTO_CLOSE_OOR_UP_MIN", "60")), // above-range for this long -> close (armed by in-range history OR distance)
  FOLLOW_OOR_UP_MIN     : parseFloat(env("FOLLOW_OOR_UP_MIN", "0")),       // follow=source targets ONLY: above-range for this long -> close even while the source still holds (0 = never pierce, current behavior). Per-target oorup=N overrides.
  MAX_UNTOUCHED_AGE_H : parseFloat(env("MAX_UNTOUCHED_AGE_H", "6")), // above-range ladder older than this that never really earned -> close, free the capital (0 = disabled)
  STALE_FEE_PCT       : parseFloat(env("STALE_FEE_PCT", "1")),       // "never really earned" = lifetime fees under this % of deposit
  OOR_UP_ARM_PCT        : parseFloat(env("OOR_UP_ARM_PCT", "10")),         // never-touched ladders arm the upside timer once price is this % above the ladder top
  HOLD_CLOSE_POS_PCT : env("HOLD_CLOSE_POS_PCT", "0") === "off" ? null : parseFloat(env("HOLD_CLOSE_POS_PCT", "0")), // mirror-hold fill-through: close IMMEDIATELY if fee-inclusive PnL is above this % at the moment price exits below our ladder; negative fills ride for reversion ("off" = everything rides)
  SOL_RESERVE        : parseFloat(env("SOL_RESERVE", "3")),     // always keep this much SOL liquid for fees/rent — opens downsize to respect it
  MIN_OPEN_SOL       : parseFloat(env("MIN_OPEN_SOL", "3")),     // don't bother opening a downsized position smaller than this
  HARD_SL_COOLDOWN_MIN : parseFloat(env("HARD_SL_COOLDOWN_MIN", "60")), // after a HARD-line stop on a token, block new opens on that mint for this many minutes, all wallets (0 = off)
  MAX_MINT_SOL       : parseFloat(env("MAX_MINT_SOL", "120")),   // total SOL across all open positions in ONE token; new opens downsize into remaining headroom or skip (0 = off)

  ADDS_MIN_SRC_SOL   : parseFloat(env("ADDS_MIN_SRC_SOL", "1")), // adds=on targets: min source deposit growth (SOL value) that triggers a mirrored add
  SHAPE_MIRROR       : env("SHAPE_MIRROR", "true") !== "false", // mirror the source's liquidity shape (Spot/BidAsk/Curve) instead of always BidAsk
  SHAPE_ON_WIDE      : env("SHAPE_ON_WIDE", "false") === "true", // apply detected shape on the >69-bin multi-position path too (leave off until that path is live-verified)
  SHAPE_RATIO_BIDASK : parseFloat(env("SHAPE_RATIO_BIDASK", "1.6")), // far/near liquidity ratio above this = BidAsk
  SHAPE_RATIO_CURVE  : parseFloat(env("SHAPE_RATIO_CURVE", "0.6")),  // below this = Curve; between = Spot

  STATE_FILE : env("STATE_FILE", path.join(__dirname, "copylp_state.json")),
  DATAPI     : "https://dlmm.datapi.meteora.ag",
  JUP        : env("JUP_BASE", "https://lite-api.jup.ag"), // with a key: JUP_BASE=https://api.jup.ag
  JUP_API_KEY: env("JUP_API_KEY", ""),
  // GROUP_BUDGETS: "name:sol,name:sol" — each group's combined open exposure (SOL cost basis)
  // is capped at a fixed SOL amount, e.g. fast:80 = the fast group may hold at most 80 SOL open.
  // Targets join a group via the per-target key group=<name>. Ungrouped targets are unbudgeted.
  // GROUP_BUDGETS entry forms: "name:25" = reservation + ceiling (25 SOL held for the group,
  // group capped at 25). "name:25cap" = CEILING ONLY — group still cannot exceed 25, but its
  // unspent budget is NOT reserved: other wallets may freely spend into it.
  GROUP_BUDGETS: Object.fromEntries(env("GROUP_BUDGETS", "").split(",").map(x => x.trim()).filter(Boolean)
    .map(x => { const [n, v] = x.split(":"); return [n, parseFloat(v)]; }).filter(([, v]) => isFinite(v) && v > 0)),
  GROUP_CAP_ONLY: new Set(env("GROUP_BUDGETS", "").split(",").map(x => x.trim()).filter(Boolean)
    .filter(x => /cap\s*$/i.test(x)).map(x => x.split(":")[0])),
  // "name:27res" = RESERVE ONLY — N SOL is held for the group (others can't touch it), but the
  // group itself has NO ceiling: once its reserve is deployed it keeps following into any SOL
  // that is genuinely free (not reserved by other groups, above SOL_RESERVE).
  GROUP_RES_ONLY: new Set(env("GROUP_BUDGETS", "").split(",").map(x => x.trim()).filter(Boolean)
    .filter(x => /res\s*$/i.test(x)).map(x => x.split(":")[0])),
};
const jfetch = (url, opts = {}) => fetch(url, { ...opts,
  headers: { ...(opts.headers || {}), ...(CFG.JUP_API_KEY ? { "x-api-key": CFG.JUP_API_KEY } : {}) } });
const SOL_MINT = "So11111111111111111111111111111111111111112";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

if (!CFG.HELIUS_API_KEY) { console.error("HELIUS_API_KEY missing"); process.exit(1); }
if (!CFG.DRY_RUN && !CFG.PRIVATE_KEY) { console.error("PRIVATE_KEY required when DRY_RUN=false"); process.exit(1); }
// target syntax: addr[:maxSol] (legacy) or addr[:key=val]... with keys:
//   max=30  cap per position | fixed=30 always open this size | min=1 override MIN_TARGET_DEPOSIT_SOL
//   pct=25  per-wallet copy ratio: our SOL = their deposit * 25% (overrides global COPY_RATIO_PCT)
//   lowmcap=5  coins under MIN_MCAP_USD aren't skipped for this wallet — they open at this fixed SOL size
//   PER-TARGET GATE OVERRIDES (for launch-day / fresh-pool specialists; 0 = gate off for this wallet only):
//   age=0      min token age hours (overrides MIN_TOKEN_AGE_H)      mcap=0  min mcap USD (overrides MIN_MCAP_USD)
//   jup=0      min Jupiter organic score (overrides MIN_JUP_SCORE)  feetvl=0  min pool fee/TVL %/24h (overrides MIN_FEE_TVL_24H_PCT)
//   width=source  mirror their exact ladder: no tiered width floor and no MIN_RANGE_DEPTH_PCT extension
//   group=fast    assign wallet to a budget group; GROUP_BUDGETS=fast:80 caps that group's combined
//                 open exposure at 80 SOL
// e.g. self-follow: MyScoutWallet:fixed=30:min=1 · percent-follow: Whale:pct=25:max=25
//      launch sniper: 9mCE…:pct=99:max=10:sl=off:hard=18:follow=source:width=source:age=0:mcap=0:feetvl=0
//      two-sided source, copy SOL side only: CdtT…:fixed=2:min=1:tokside=60:follow=source:width=source:age=0:mcap=0:jup=0:feetvl=0:churn=off:pump=off:scr=off:hard=30
const TARGET_CFG = CFG.TARGET_WALLETS.split(",").map(s => s.trim()).filter(Boolean).map(s => {
  const parts = s.split(":");
  const t = { addr: parts[0], maxSol: null, fixedSol: null, minDep: null, pct: null, lowMcapSol: null,
              slPct: null, hotPct: null, hardPct: null, follow: null, oorUpMin: null,
              minAgeH: null, minMcapUsd: null, minJup: null, minFeeTvl: null, maxTaxBps: null, width: null, group: null, followAdds: false, pumpOff: false };
  for (const p of parts.slice(1)) {
    if (p.includes("=")) {
      const [k, v] = p.split("=");
      if (k === "max") t.maxSol = parseFloat(v);
      else if (k === "fixed") t.fixedSol = parseFloat(v);
      else if (k === "min") t.minDep = parseFloat(v);
      else if (k === "pct") t.pct = parseFloat(v);
      else if (k === "lowmcap") t.lowMcapSol = parseFloat(v);
      else if (k === "sl") t.slPct = v === "off" ? 0 : parseFloat(v);      // per-wallet soft stop; off = disabled
      else if (k === "hot") t.hotPct = v === "off" ? 0 : parseFloat(v);    // per-wallet hot stop; off = disabled
      else if (k === "hard") t.hardPct = v === "off" ? 0 : parseFloat(v);  // per-wallet hard collapse line
      else if (k === "follow") t.follow = v;                                 // follow=source: no overlay closes while the source position is still open
      else if (k === "oorup") t.oorUpMin = v === "off" ? -1 : parseFloat(v); // per-wallet OOR-up timer (minutes). On follow=source wallets this PIERCES the hold; off = never close on OOR-up for this wallet
      else if (k === "age") t.minAgeH = parseFloat(v);                       // per-wallet token-age gate (0 = off)
      else if (k === "mcap") t.minMcapUsd = parseFloat(v);                   // per-wallet mcap gate (0 = off)
      else if (k === "pump") t.pumpOff = v === "off";                        // v0.6.21 pump=off: exempt this wallet from the pump gate
      else if (k === "jup") t.minJup = parseFloat(v);                        // per-wallet jup organic-score gate (0 = off)
      else if (k === "width") t.width = v;                                   // width=source: no width floor / depth extension
      else if (k === "adds") t.followAdds = v === "on";                      // adds=on: mirror the source ADDING liquidity to a position we already copied (layered shapes)
      else if (k === "tax") t.maxTaxBps = parseFloat(v);                     // per-wallet transfer-tax ceiling in bps (0 = off)
      else if (k === "feetvl") t.minFeeTvl = parseFloat(v);                  // per-wallet pool fee/TVL gate (0 = off)
      else if (k === "group") t.group = v;                                   // budget group name (see GROUP_BUDGETS)
      else if (k === "scr") t.scrGate = v.toLowerCase();                    // per-wallet screener gate: off|shadow|veto|strict
      else if (k === "churn") t.churnCap = v === "off" ? 0 : parseInt(v, 10);  // per-wallet churn guard: off | N opens per MINT_OPEN_WINDOW_MIN (overrides MAX_OPENS_PER_MINT)
      else if (k === "extra") {                                              // v0.6.23 extra=bidask50 / spot60 ...: second leg, same size, fixed shape+depth
        const mm = /^(bidask|spot|curve)(\d+)$/i.exec(v);
        if (mm) t.extra = { shape: { bidask: "BidAsk", spot: "Spot", curve: "Curve" }[mm[1].toLowerCase()], depth: parseFloat(mm[2]), name: mm[1].toLowerCase() + mm[2] };
      }
      else if (k === "tokside") t.maxTokSidePct = parseFloat(v);           // v0.6.22 two-sided sources: copy if their token side is <= this % of value (default 30). We still copy only the SOL side below price.
    } else if (p) t.maxSol = parseFloat(p); // legacy bare number = max
  }
  return t;
});
const TARGETS = TARGET_CFG.map(t => t.addr);
const TCFG = Object.fromEntries(TARGET_CFG.map(t => [t.addr, t]));
// effective stop lines for a target: per-wallet override (0 = off) or global default.
// hard line is checked FIRST and independently — it must fire even when the soft stop is off.
// latest set of each source wallet's open position addresses, refreshed every tick.
// follow=source targets: while the source position is still open we make NO overlay closes
// (no OOR-up timer, no untouched-age, no OOR-below) — we exit when they exit, or at the
// hard collapse line. Before the first successful fetch we assume alive (no boot-time closes).
const lastSrcOpen = {};
const mirrorHold = m => (TCFG[m.target]?.follow === "source") && !!m.srcPos &&
  (lastSrcOpen[m.target] ? lastSrcOpen[m.target].has(m.srcPos) : true);
const slCfgFor = target => {
  const t = TCFG[target] || {};
  return {
    sl:   t.slPct   != null ? t.slPct   : CFG.STOP_LOSS_PCT,
    hot:  t.hotPct  != null ? t.hotPct  : (t.slPct === 0 ? 0 : CFG.STOP_LOSS_HOT_PCT), // sl=off implies hot off unless hot= given
    hard: t.hardPct != null ? t.hardPct : CFG.IN_RANGE_HARD_SL_PCT,
  };
};
const MAX_SOL_BY_TARGET = Object.fromEntries(TARGET_CFG.filter(t => t.maxSol).map(t => [t.addr, t.maxSol]));
if (!TARGETS.length) { console.error("TARGET_WALLETS is empty"); process.exit(1); }

// disableRetryOnRateLimit: web3.js's internal 500ms retry hammer turns a 429 into a storm
// (every retry adds load to an already-saturated key). Surfacing the 429 lets withRetry's
// exponential backoff (1.5s -> 3s -> 6s) handle it instead — fewer requests, faster recovery.
// RPC_URL (e.g. http://127.0.0.1:8899 for the shared rpcproxy) overrides the direct Helius URL.
// WS subscriptions still go direct to Helius via wsEndpoint — the proxy is HTTP-only.
const conn = new Connection(CFG.RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_API_KEY}`,
  { commitment: "confirmed", disableRetryOnRateLimit: true,
    wsEndpoint: `wss://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_API_KEY}` });

// ---- short-TTL READ CACHE ------------------------------------------------------------
// The DLMM SDK re-reads the same lbPair + bin-array accounts for every getPosition() in a pool.
// A guard pass over 8 ladders in one pool = 8x identical reads. Dedupe identical
// getAccountInfo / getMultipleAccountsInfo calls within READ_CACHE_MS. Writes, sends,
// blockhash, simulate and signature polling are NOT touched. Staleness is bounded to the
// TTL (default 2.5s) — every money decision here runs on a >=5s cadence anyway.
const READ_CACHE_MS = parseFloat(env("READ_CACHE_MS", "2500"));
const rpcStats = { hit: 0, miss: 0, t0: Date.now() };
if (READ_CACHE_MS > 0) {
  const cache = new Map(); // key -> { t, p }
  const wrap = (method, keyFn) => {
    const orig = conn[method].bind(conn);
    conn[method] = (...args) => {
      const key = method + "|" + keyFn(...args);
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.t < READ_CACHE_MS) { rpcStats.hit++; return hit.p; }
      rpcStats.miss++;
      const p = orig(...args);
      cache.set(key, { t: now, p });
      p.catch(() => cache.delete(key)); // never cache a failure
      if (cache.size > 5000) for (const [k, v] of cache) if (now - v.t >= READ_CACHE_MS) cache.delete(k);
      return p;
    };
  };
  const optKey = o => (typeof o === "string" ? o : o?.commitment || "") + "|" + (o?.encoding || "") + "|" + (o?.dataSlice ? JSON.stringify(o.dataSlice) : "");
  wrap("getAccountInfo",               (pk, o) => pk.toString() + "|" + optKey(o));
  wrap("getAccountInfoAndContext",     (pk, o) => pk.toString() + "|" + optKey(o));
  wrap("getMultipleAccountsInfo",      (pks, o) => pks.map(p => p.toString()).join(",") + "|" + optKey(o));
  wrap("getMultipleAccountsInfoAndContext", (pks, o) => pks.map(p => p.toString()).join(",") + "|" + optKey(o));
}
// hourly read-budget line so the effect is visible in the log
setInterval(() => {
  const h = (Date.now() - rpcStats.t0) / 3.6e6;
  console.log(new Date().toISOString(), `rpc reads: ${rpcStats.miss} sent, ${rpcStats.hit} served from cache (${(rpcStats.hit / Math.max(1, rpcStats.hit + rpcStats.miss) * 100).toFixed(0)}% hit) — ${(rpcStats.miss / Math.max(h, 0.01)).toFixed(0)}/h`);
}, 3_600_000).unref();
const signer = CFG.PRIVATE_KEY ? Keypair.fromSecretKey((bs58.decode ?? bs58.default.decode)(CFG.PRIVATE_KEY)) : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", e => log("UNHANDLED:", e?.message || e));
process.on("uncaughtException", e => log("UNCAUGHT:", e?.message || e));

async function withRetry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const msg = e?.message || String(e);
      if (!/503|429|502|504|imed out|fetch failed|ECONN/i.test(msg)) throw e;
      const wait = 600 * 2 ** i;
      log(`  ${label} transient, retry ${i + 1}/${tries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

// state: { seen: {targetWallet: {srcPosAddr: true}}, mine: {ourPosAddr: {...}}, init: {wallet:true} }
// ---- SINGLE-INSTANCE LOCK -------------------------------------------------------------------
// Two processes on one state file silently destroy each other's ledger writes: A records an open,
// B saves its own (older) copy over it, B's sweep then sees the position as an orphan and (with
// ORPHAN_POLICY=close) immediately unwinds it. Caused by pm2 ghost forks 2026-08-29 and 2026-09-08.
// Refuse to boot if another live process holds this state file. LOCK_OVERRIDE=1 bypasses.
const LOCK_FILE = CFG.STATE_FILE + ".lock";
const LOCK_STALE_MS = 90_000;
function lockAlive(l) {
  if (!l || Date.now() - (l.hb || 0) > LOCK_STALE_MS) return false;
  try { process.kill(l.pid, 0); return true; } catch { return false; }   // pid gone -> stale lock
}
(function acquireLock() {
  if (env("LOCK_OVERRIDE", "0") === "1") return;
  if (process.argv.some(a => a.startsWith("--close") || a === "--version" || a === "--scr-report" || a === "--ledger-report")) return; // short deliberate CLI runs
  let held = null;
  try { held = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch {}
  if (lockAlive(held)) {
    console.error(`FATAL: ${CFG.STATE_FILE} is already in use by pid ${held.pid} (heartbeat ${((Date.now() - held.hb) / 1000).toFixed(0)}s ago, started ${held.started}).`);
    console.error(`Another copylp is running against this folder — usually a pm2 ghost fork. Check:`);
    console.error(`  pm2 list`);
    console.error(`  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CreationDate,CommandLine | Format-List`);
    console.error(`Kill the stray process, then start again. (LOCK_OVERRIDE=1 forces past this.)`);
    process.exit(1);
  }
  const write = () => { try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, hb: Date.now(), started: new Date().toISOString() })); } catch {} };
  write();
  setInterval(write, 30_000).unref();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { fs.unlinkSync(LOCK_FILE); } catch {} process.exit(0); });
  process.on("exit", () => { try { const l = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); if (l.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} });
})();

let S = { seen: {}, mine: {}, init: {} };
try { S = JSON.parse(fs.readFileSync(CFG.STATE_FILE, "utf8")); } catch {}
S.seen = S.seen || {}; S.mine = S.mine || {}; S.init = S.init || {};
S.paused = S.paused || {};
S.spikePools = S.spikePools || {}; // pool -> { until, rate } — fee-spike open/add block
for (const [k, v] of Object.entries(S.spikePools)) if (!(v && v.until > Date.now())) delete S.spikePools[k];
S.slCooldown = S.slCooldown || {}; // mint -> { until, at, pnl, target } — hard-SL re-entry block
for (const [k, v] of Object.entries(S.slCooldown)) if (!(v && v.until > Date.now())) delete S.slCooldown[k];
for (const m of Object.values(S.mine)) {
  if (m.peakPnl !== undefined) m.peakPnl = Number.isFinite(+m.peakPnl) ? +m.peakPnl : undefined;
  if (m.lastPnl !== undefined) m.lastPnl = Number.isFinite(+m.lastPnl) ? +m.lastPnl : undefined;
}
for (const w of CFG.PAUSED_TARGETS) if (!S.paused[w]) S.paused[w] = { at: Date.now(), manual: true };
for (const w of Object.keys(S.paused)) if (S.paused[w].manual && !CFG.PAUSED_TARGETS.includes(w)) delete S.paused[w];
const save = () => fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(S, null, 2));

const myOpenCount = () => Object.values(S.mine).filter(m => !m.closed).length;
const myCountFor = w => Object.values(S.mine).filter(m => !m.closed && m.target === w).length;

// ---------------------------------------------------------------- datapi ---
async function openPositions(wallet) {
  const out = []; let page = 1;
  while (page <= 4) {
    const r = await fetch(`${CFG.DATAPI}/portfolio/open?user=${wallet}&page=${page}&page_size=50`, { headers: UA });
    if (!r.ok) throw new Error(`datapi ${r.status}`);
    const j = await r.json();
    for (const pool of j.pools || []) {
      for (const posAddr of pool.listPositions || []) {
        out.push({
          pos: posAddr, pool: pool.poolAddress, binStep: pool.binStep,
          tokenX: pool.tokenXMint, tokenY: pool.tokenYMint,
          balances: pool.balances, balancesSol: pool.balancesSol,
          unclaimedFeesSol: pool.unclaimedFeesSol,
          pnlSolPct: pool.pnlSolPctChange, outOfRange: pool.outOfRange, poolPrice: pool.poolPrice,
        });
      }
    }
    if (!j.hasNext) break;
    page++;
  }
  return out;
}

// ------------------------------------------------------------ token gates --
const tokenCache = new Map();
// Token-2022 transferFeeConfig reader. Returns basis points (0 for legacy SPL / no extension).
// Cached indefinitely: a mint's fee CAN be changed by its config authority, but re-reading per open
// would cost an RPC call on the hot path; 6h is a safe compromise.
const taxCache = new Map();
async function tokenTaxBps(mint) {
  const c = taxCache.get(mint);
  if (c && Date.now() - c.at < 6 * 3600_000) return c.bps;
  let bps = 0;
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const v = info && info.value;
    if (v && v.owner && v.owner.toBase58() === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
      const exts = (v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.extensions) || [];
      const tf = exts.find(e => e.extension === "transferFeeConfig");
      if (tf) bps = Number(tf.state.newerTransferFee.transferFeeBasisPoints) || 0;
    }
  } catch (e) { return 0; } // read failed -> don't block the open on it, but don't cache either
  taxCache.set(mint, { at: Date.now(), bps });
  return bps;
}

async function tokenGate(mint, tOv = {}) {
  if (CFG.IGNORED_MINTS.includes(mint)) return { ok: false, why: "ignored mint" };
  // transfer-tax gate (per-target `tax=` overrides; 0 disables for that wallet)
  const maxTax = tOv.maxTaxBps != null ? tOv.maxTaxBps : CFG.MAX_TOKEN_TAX_BPS;
  const taxBps = await tokenTaxBps(mint);
  if (taxBps > 0 && maxTax > 0 && taxBps > maxTax) {
    if (CFG.TAX_SIZE_MULT > 0) return { ok: true, taxBps, sizeMult: CFG.TAX_SIZE_MULT,
      note: `token tax ${(taxBps / 100).toFixed(2)}% > ${(maxTax / 100).toFixed(2)}% — sizing at ${(CFG.TAX_SIZE_MULT * 100).toFixed(0)}%` };
    return { ok: false, why: `token tax ${(taxBps / 100).toFixed(2)}% > max ${(maxTax / 100).toFixed(2)}% (costs ~${(2 * taxBps / 100).toFixed(1)}% round-trip on the token leg)` };
  }
  const c = tokenCache.get(mint);
  const pumpOn = !tOv.pumpOff && (CFG.MAX_PUMP_1H_PCT > 0 || CFG.MAX_PUMP_6H_PCT > 0);
  let t = c && Date.now() - c.at < (pumpOn ? 5 : 15) * 60_000 ? c.t : null;   // pump gate needs fresher stats
  if (!t) {
    try {
      const r = await jfetch(`${CFG.JUP}/tokens/v2/search?query=${mint}`).then(x => x.json());
      t = Array.isArray(r) ? r.find(x => x.id === mint) : null;
      tokenCache.set(mint, { at: Date.now(), t });
    } catch {}
  }
  if (!t) {
    // v0.6.21: Jupiter has no data — use Meteora's market cap for the mcap gate instead of skipping it
    try {
      const j = await fetch(`${CFG.DATAPI}/pools?query=${mint}&page_size=5`, { headers: UA }).then(x => x.json());
      const p = (j.data || []).find(x => x.token_x?.address === mint);
      if (p && +p.token_x.market_cap > 0) t = { mcap: +p.token_x.market_cap, _src: "meteora" };
    } catch {}
    if (!t) return { ok: true, note: "no token data from Jupiter or Meteora (gates skipped)" };
  }
  if (pumpOn && t.stats1h) {
    const c1 = +(t.stats1h?.priceChange), c6 = +(t.stats6h?.priceChange);
    if (CFG.MAX_PUMP_1H_PCT > 0 && c1 > CFG.MAX_PUMP_1H_PCT) return { ok: false, why: `pump gate: up ${c1.toFixed(0)}% in 1h (> ${CFG.MAX_PUMP_1H_PCT}%)` };
    if (CFG.MAX_PUMP_6H_PCT > 0 && c6 > CFG.MAX_PUMP_6H_PCT) return { ok: false, why: `pump gate: up ${c6.toFixed(0)}% in 6h (> ${CFG.MAX_PUMP_6H_PCT}%)` };
  }
  // effective thresholds: per-target override wins (0 = that gate is off for this wallet)
  const minJup  = tOv.minJup     != null ? tOv.minJup     : CFG.MIN_JUP_SCORE;
  const minMcap = tOv.minMcapUsd != null ? tOv.minMcapUsd : CFG.MIN_MCAP_USD;
  const minAge  = tOv.minAgeH    != null ? tOv.minAgeH    : CFG.MIN_TOKEN_AGE_H;
  const ovNote  = [tOv.minJup != null && "jup", tOv.minMcapUsd != null && "mcap", tOv.minAgeH != null && "age"].filter(Boolean);
  if (minJup && t.organicScore != null && t.organicScore < minJup)
    return { ok: false, why: `jup score ${t.organicScore.toFixed(0)} < ${minJup}` };
  if (minMcap && t.mcap == null) {
    if (tOv.lowMcapSol > 0) return { ok: true, lowMcap: true, mcap: 0 };
    return { ok: false, why: "mcap unknown (token too new for data) — failing closed" };
  }
  if (minMcap && t.mcap != null && t.mcap < minMcap) {
    // lowmcap targets don't skip sub-threshold coins — they open at reduced fixed size instead
    if (tOv.lowMcapSol > 0)
      return { ok: true, lowMcap: true, mcap: t.mcap };
    return { ok: false, why: `mcap $${(t.mcap / 1e6).toFixed(2)}M < $${minMcap / 1e6}M` };
  }
  if (minAge && t.firstPool?.createdAt && !(mint in CFG.AGE_ALLOWLIST)) {
    const ageH = (Date.now() - new Date(t.firstPool.createdAt).getTime()) / 3.6e6;
    if (ageH < minAge) return { ok: false, why: `token age ${ageH.toFixed(0)}h < ${minAge}h` };
  } else if (mint in CFG.AGE_ALLOWLIST) {
    log(`  age gate bypassed for allowlisted mint ${mint.slice(0, 6)}…${CFG.AGE_ALLOWLIST[mint] ? ` (capped at ${CFG.AGE_ALLOWLIST[mint]} SOL)` : ""}`);
  }
  return { ok: true, mcap: t.mcap ?? null, taxBps, note: ovNote.length ? `per-target gate override: ${ovNote.join("/")}` : undefined };
}


const poolFeeCache = new Map();
async function poolFeeGate(poolAddr, tOv = {}) {
  const minPct = tOv.minFeeTvl != null ? tOv.minFeeTvl : CFG.MIN_FEE_TVL_24H_PCT;
  if (!minPct) return { ok: true, note: tOv.minFeeTvl != null ? "per-target feetvl gate off" : undefined };
  const c = poolFeeCache.get(poolAddr);
  if (c && Date.now() - c.at < 10 * 60_000 && c.minPct === minPct) return c.v;
  let v = { ok: true, note: "fee data unavailable (gate skipped)" };
  try {
    const j = await fetch(`${CFG.DATAPI}/pools?query=${poolAddr}&page_size=5`, { headers: UA }).then(x => x.json());
    const p = (j.data || []).find(x => x.address === poolAddr);
    if (p && p.tvl > 0) {
      const pct = ((p.fees?.["24h"] || 0) / p.tvl) * 100;
      v = pct >= minPct ? { ok: true, pct }
        : { ok: false, why: `pool fee/TVL ${pct.toFixed(2)}%/24h < ${minPct}%` };
    }
  } catch {}
  poolFeeCache.set(poolAddr, { at: Date.now(), v, minPct });
  return v;
}

// -------------------------------------------------------------- dlmm ops ---
const dlmmCache = new Map();
// PENDING-CHUNK REGISTRY: every position keypair the bot generates is registered with its source
// linkage BEFORE the tx is sent. If any open path loses track of a chunk (confirmation race, husk
// cleanup glitch, sweep racing the record step), the orphan sweep consults this registry and
// adopts WITH linkage instead of target=null. Entries expire after PENDING_TTL_MS.
const pendingChunks = new Map(); // posAddr -> { target, srcPos, pool, mint, minBin, maxBin, step, shape, ts }
const PENDING_TTL_MS = 30 * 60_000;
function registerPending(addr, link) { pendingChunks.set(addr, { ...link, ts: Date.now() }); }
function prunePending() { const now = Date.now(); for (const [a, v] of pendingChunks) if (now - v.ts > PENDING_TTL_MS) pendingChunks.delete(a); }
const lbFresh = new Map();   // pool -> ms timestamp of last lbPair refresh (WS push or tick batch read)
const LB_FRESH_MS = parseFloat(env("LB_FRESH_MS", "15000")); // reuse pushed activeId this long before paying an RPC read
async function getDlmm(addr) {
  if (!dlmmCache.has(addr)) dlmmCache.set(addr, await withRetry(() => DLMM.create(conn, new PublicKey(addr)), "dlmm.create"));
  return dlmmCache.get(addr);
}

// Classify a source position's liquidity shape from its per-bin distribution.
// IMPORTANT: uses position* fields (the source's own share), NOT bin* fields (bin totals across all LPs).
// Returns { name, strategyType, ratio } — any ambiguity/error falls back to BidAsk (prior behavior).
function classifyShape(positionBinData, activeId) {
  const FALLBACK = { name: "BidAsk", strategyType: StrategyType.BidAsk, ratio: null };
  try {
    if (!Array.isArray(positionBinData) || positionBinData.length === 0) return FALLBACK;
    const bins = positionBinData.map(b => {
      let w = parseFloat(b.positionLiquidity);
      if (!isFinite(w) || w <= 0) {
        const x = parseFloat(b.positionXAmount) || 0, y = parseFloat(b.positionYAmount) || 0;
        const p = parseFloat(b.pricePerToken) || 0;
        w = y + x * p;
      }
      return { binId: b.binId, w };
    }).filter(b => b.w > 0);
    if (bins.length < 6) return FALLBACK; // too few bins for shape to mean anything
    const below = bins.filter(b => b.binId < activeId).sort((a, b) => b.binId - a.binId); // nearest active first
    const above = bins.filter(b => b.binId > activeId).sort((a, b) => a.binId - b.binId);
    const sum = arr => arr.reduce((a, b) => a + b.w, 0);
    const side = sum(below) >= sum(above) ? below : above; // dominant side (single-sided is the norm)
    if (side.length < 6) return FALLBACK;
    const k = Math.max(1, Math.floor(side.length / 3));
    const near = sum(side.slice(0, k)) / k;
    const far = sum(side.slice(side.length - k)) / k;
    const ratio = near > 0 ? far / near : Infinity;
    const name = ratio > CFG.SHAPE_RATIO_BIDASK ? "BidAsk"
               : ratio < CFG.SHAPE_RATIO_CURVE ? "Curve" : "Spot";
    return { name, strategyType: StrategyType[name], ratio };
  } catch { return FALLBACK; }
}

// Compact per-bin snapshot of a source position's SOL side (positionYAmount, lamports).
// v0.6.8: MUST be Y-lamports — positionLiquidity is a raw Q64 share integer whose deltas are
// astronomically large and sized a real add to the max= cap (the +9.2e19 "SOL" incident).
// Y-only is also the correct sizing basis: we deposit SOL-side only, so the mirrored add should
// track the SOURCE's SOL-side growth, not token-side value.
function snapSrcBins(positionBinData) {
  const bins = {}; let total = 0;
  for (const b of positionBinData || []) {
    const y = parseFloat(b.positionYAmount) || 0;
    if (y > 0) { bins[b.binId] = y; total += y; }
  }
  return { bins, total: total / LAMPORTS_PER_SOL };
}

// adds=on: detect the source depositing MORE into a position we already mirror, and mirror the
// delta into our existing position account — with the DELTA's own shape, so a BidAsk open with a
// Spot top-up produces the layered curve on our side too. SOL-side only (bins <= activeId), and
// clamped to our position's fixed bin span (a delta outside our span cannot be followed).
const _addsChecked = new Map(); // myPosAddr -> last check ts
async function followAdds(target, nowSet) {
  const tag = target.slice(0, 6);
  for (const [addr, m] of Object.entries(S.mine)) {
    if (m.closed || m.target !== target || !m.srcPos || !nowSet.has(m.srcPos)) continue;
    if (m.siblings && m.siblings.length && m.addPrimary === false) continue; // adds apply via the primary chunk only
    const last = _addsChecked.get(addr) || 0;
    if (Date.now() - last < 40_000) continue;
    _addsChecked.set(addr, Date.now());
    try {
      // v0.6.9: the TRIGGER is datapi allTimeDeposits — it moves ONLY when the owner deposits.
      // A position's live SOL-side balance also moves when price trades through bins (fills), which
      // is what generated phantom "+1.70 added / trimmed 0.59" events on plain chop. Deposits are
      // fill-immune, so no chain read and no trade happens unless the source actually added.
      let depSol = null;
      try {
        const r = await fetch(`${CFG.DATAPI}/positions/${m.pool}/pnl?user=${target}&status=open&page_size=100`, { headers: UA });
        if (r.ok) {
          const j = await r.json();
          const row = (j.data || j.positions || []).find(p => p.positionAddress === m.srcPos);
          if (row && row.allTimeDeposits)
            depSol = (parseFloat(row.allTimeDeposits?.tokenY?.amountSol) || 0) +
                     (parseFloat(row.allTimeDeposits?.tokenX?.amountSol) || 0);
        }
      } catch {}
      if (depSol == null) continue; // indexer miss this tick — try again next tick
      if (m.srcDepSol == null) { // baseline (first look, or position from pre-0.6.9)
        m.srcDepSol = depSol; save();
        log(`  [${tag}] adds: baselined ${m.srcPos.slice(0, 6)} at ${depSol.toFixed(2)} SOL deposited — following top-ups from here`);
        continue;
      }
      const delta = depSol - m.srcDepSol;
      if (!isFinite(delta) || delta > 10_000) { // never trade on corrupt data
        m.srcDepSol = depSol; save();
        log(`  [${tag}] adds: implausible deposit delta ${delta} on ${m.srcPos.slice(0, 6)} — re-baselined, no trade`);
        continue;
      }
      if (delta < CFG.ADDS_MIN_SRC_SOL) continue;
      if (spikeBlockLeft(m.pool) > 0) { // fee spike on this pool: don't add into a possible sell-off — skip this add for good
        m.srcDepSol = depSol; save();
        log(`  [${tag}] adds: source added ${delta.toFixed(2)} SOL on ${m.srcPos.slice(0, 6)} but pool is fee-spiking — not following this add`);
        continue;
      }

      // deposit confirmed -> chain read ONLY NOW, for the add's shape + span. The per-bin Y diff
      // vs our stored snapshot approximates the add's distribution; if fills have polluted it
      // beyond recognition (diff total far from the deposit delta), fall back to Spot over our span.
      const dlmm = await getDlmm(m.pool);
      await withRetry(() => dlmm.refetchStates(), "adds refetch", 2).catch(() => {});
      const activeId = dlmm.lbPair.activeId;
      let p;
      try { p = await withRetry(() => dlmm.getPosition(new PublicKey(m.srcPos)), "adds getPosition", 2); }
      catch { continue; } // unreadable this tick; deposit delta persists, retry next tick
      const snap = snapSrcBins(p.positionData.positionBinData);
      const dbins = [];
      let diffTotal = 0;
      for (const [bid, w] of Object.entries(snap.bins)) {
        const dv = w - ((m.srcSnap || {})[bid] || 0);
        if (dv > 0) { dbins.push({ binId: Number(bid), positionLiquidity: String(dv) }); diffTotal += dv / LAMPORTS_PER_SOL; }
      }
      const diffOk = m.srcSnap && dbins.length >= 3 && diffTotal > delta * 0.5 && diffTotal < delta * 2;
      let addShape, lo, hi;
      if (diffOk) {
        addShape = CFG.SHAPE_MIRROR ? classifyShape(dbins, activeId)
                                    : { name: "Spot", strategyType: StrategyType.Spot, ratio: null };
        const dLo = Math.min(...dbins.map(b => b.binId)), dHi = Math.max(...dbins.map(b => b.binId));
        lo = Math.max(dLo, m.minBin); hi = Math.min(dHi, m.maxBin, activeId);
        if (hi < lo) {
          m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total; save();
          log(`  [${tag}] adds: source deposited ${delta.toFixed(2)} SOL in bins ${dLo}..${dHi} — outside our span ${m.minBin}..${m.maxBin} / above active — skipped`);
          continue;
        }
      } else {
        addShape = { name: "Spot", strategyType: StrategyType.Spot, ratio: null };
        lo = m.minBin; hi = Math.min(m.maxBin, activeId);
        if (hi < lo) {
          m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total; save();
          log(`  [${tag}] adds: source deposited ${delta.toFixed(2)} SOL but our whole span is above active — skipped`);
          continue;
        }
        log(`  [${tag}] adds: bin-diff unreliable (fills since baseline) — mirroring ${delta.toFixed(2)} SOL deposit as Spot across our span`);
      }

      // sizing: pct like the open; else proportional to our original copy ratio; capped by max/global/balance
      const tOv = TCFG[target] || {};
      const ratio = tOv.pct != null ? tOv.pct / 100
                  : (m.srcVal > 0 ? (m.solIn || 0) / m.srcVal : 0);
      let sol = delta * ratio;
      const capTotal = tOv.maxSol ?? CFG.MAX_COPY_SOL;
      if (capTotal && (m.solIn || 0) + sol > capTotal) sol = Math.max(0, capTotal - (m.solIn || 0));
      // group budget: same reservation+ceiling rules as the open path.
      // (a) our own group's ceiling caps the add; (b) other groups' UNSPENT budgets are
      // reserved out of the balance so an add can never eat their allocation.
      const openByGroup = {};
      for (const x of Object.values(S.mine)) {
        if (x.closed) continue;
        const g = (TCFG[x.target] || {}).group;
        if (g != null) openByGroup[g] = (openByGroup[g] || 0) + (x.solIn || 0);
      }
      const myGrp = tOv.group;
      if (myGrp != null && CFG.GROUP_BUDGETS[myGrp] != null && !CFG.GROUP_RES_ONLY.has(myGrp)) { // res-only: no ceiling on adds either
        const headroom = CFG.GROUP_BUDGETS[myGrp] - (openByGroup[myGrp] || 0);
        if (headroom < sol) {
          if (headroom <= 0.2) {
            m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total; save();
            log(`  [${tag}] adds: group '${myGrp}' exposure ${(openByGroup[myGrp] || 0).toFixed(1)}/${CFG.GROUP_BUDGETS[myGrp]} SOL — budget full, add skipped`);
            continue;
          }
          log(`  [${tag}] adds: group '${myGrp}' ${(openByGroup[myGrp] || 0).toFixed(1)}/${CFG.GROUP_BUDGETS[myGrp]} SOL — downsizing add ${sol.toFixed(1)} -> ${headroom.toFixed(1)}`);
          sol = headroom;
        }
      }
      if (signer && !CFG.DRY_RUN) {
        let reservedForOthers = 0;
        for (const g of Object.keys(CFG.GROUP_BUDGETS)) {
          if (g === myGrp || CFG.GROUP_CAP_ONLY.has(g)) continue; // cap-only groups reserve nothing
          reservedForOthers += Math.max(0, CFG.GROUP_BUDGETS[g] - (openByGroup[g] || 0));
        }
        const bal = (await conn.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL;
        sol = Math.min(sol, Math.max(0, bal - CFG.SOL_RESERVE - reservedForOthers));
      }
      if (sol < 0.2) {
        m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total; save();
        log(`  [${tag}] adds: source added ${delta.toFixed(2)} SOL but our add sizes to ${sol.toFixed(2)} (cap/balance) — skipped`);
        continue;
      }
      log(`  [${tag}] MIRROR-ADD ${m.srcPos.slice(0, 6)} -> ${addr.slice(0, 6)}: source SOL-side +${delta.toFixed(2)} SOL [${addShape.name}] bins ${lo}..${hi} -> our +${sol.toFixed(2)} SOL (position now ${((m.solIn || 0) + sol).toFixed(2)})`);
      if (CFG.DRY_RUN) { log("  [dry-run] not sent"); m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total; save(); continue; }

      let sent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const slip = Math.min(CFG.WIDE_SLIPPAGE_PCT * 2 ** attempt, 100);
        try {
          const tx = await dlmm.addLiquidityByStrategy({
            positionPubKey: new PublicKey(addr), user: signer.publicKey,
            totalXAmount: new BN(0), totalYAmount: new BN(Math.floor(sol * LAMPORTS_PER_SOL)),
            strategy: { minBinId: lo, maxBinId: hi, strategyType: addShape.strategyType },
            slippage: slip,
          });
          await ledgerRun({ pool: m.pool, mint: m.mint, target: m.target }, () => withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer], { commitment: "confirmed" }), "add send"));
          sent = true; break;
        } catch (e) {
          if (/0x1774|ExceededBinSlippage/i.test(e.message || "") && attempt < 2) {
            log(`  [${tag}] add slippage race at ${slip}% — retrying`);
            await dlmm.refetchStates().catch(() => {});
            continue;
          }
          log(`  [${tag}] add failed: ${(e.message || "").slice(0, 90)} — baseline kept, will retry next tick`);
          break;
        }
      }
      if (sent) {
        m.solIn = (m.solIn || 0) + sol;
        m.shape = m.shape + "+" + addShape.name;
        m.srcDepSol = depSol; m.srcSnap = snap.bins; m.srcVal = snap.total;
        save();
        log(`  [${tag}] ADD LANDED ${addr.slice(0, 6)}: shape now ${m.shape}, ${m.solIn.toFixed(2)} SOL in`);
      }
    } catch (e) { log(`  [${tag}] adds check error: ${(e.message || "").slice(0, 80)}`); }
  }
}

const _inflight = new Set();
const _inflightMint = new Map(); // mint -> opens in flight (janitor dust cleanup must not touch these)
const _mirrorFails = new Map(); // target:srcPos -> failed attempt count
async function mirrorOpen(target, src) {
  return ledgerRun({ pool: src.pool, mint: src.tokenX, target, open: true, flags: [] }, async () => {
    const mineHere = () => new Set(Object.entries(S.mine).filter(([, m]) => !m.closed && m.pool === src.pool && m.target === target).map(([a]) => a));
    const before = mineHere();
    const r = await mirrorOpenImpl(target, src);
    const added = [...mineHere()].filter(a => !before.has(a));
    const W = wlState(), id = W.active[lkey(src.pool, target)];
    if (id && W.eps[id] && added.length && !CFG.DRY_RUN) {
      W.eps[id].depositSol += added.reduce((acc, a) => acc + (S.mine[a].solIn || 0), 0);
      if (added.some(a => S.mine[a].scrTag && S.mine[a].scrTag.wouldBlock)) W.eps[id].flags = [...new Set([...(W.eps[id].flags || []), "scr"])];
      save();
    }
    return r;
  });
}
async function mirrorOpenImpl(target, src) {
  const tag = target.slice(0, 6);
  // dedupe race guard: realtime + backfill can deliver the same source position ~simultaneously
  const ifKey = target + ":" + src.pos;
  if (_inflight.has(ifKey)) return;
  _inflight.add(ifKey);
  _inflightMint.set(src.tokenX, (_inflightMint.get(src.tokenX) || 0) + 1); // janitor never cleans a token mid-open
  try {
    const r = await _mirrorOpen(target, src, tag);
    _mirrorFails.delete(ifKey);
    return r;
  } catch (e) {
    // v0.6.12: an ERROR (not a gate skip) used to burn the position forever because `seen` was
    // set before the attempt. Un-mark it so the next poll retries, up to 4 total attempts.
    const n = (_mirrorFails.get(ifKey) || 0) + 1;
    _mirrorFails.set(ifKey, n);
    if (n < 4 && S.seen[target] && S.seen[target][src.pos]) {
      delete S.seen[target][src.pos]; save();
      log(`  [${tag}] mirror error (attempt ${n}/4, will retry next poll): ${(e.message || "").slice(0, 90)}`);
    } else {
      log(`  [${tag}] mirror error — GIVING UP after ${n} attempts on ${src.pos.slice(0, 8)}…: ${(e.message || "").slice(0, 90)}`);
    }
  } finally {
    _inflight.delete(ifKey);
    const n = (_inflightMint.get(src.tokenX) || 1) - 1;
    if (n > 0) _inflightMint.set(src.tokenX, n); else _inflightMint.delete(src.tokenX);
  }
}
async function _mirrorOpen(target, src, tag) {
  // gates that need no chain read first
  if (src.tokenY !== SOL_MINT) return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: pool not TOKEN-SOL`);
  if (myOpenCount() >= CFG.MAX_GLOBAL_POSITIONS) return log(`  [${tag}] skip: global position cap (${CFG.MAX_GLOBAL_POSITIONS})`);
  if (myCountFor(target) >= CFG.MAX_POS_PER_WALLET) return log(`  [${tag}] skip: per-wallet cap (${CFG.MAX_POS_PER_WALLET})`);
  const openMirrors = Object.values(S.mine).filter(m => !m.closed && m.mint === src.tokenX);
  const perWallet = new Set(openMirrors.filter(m => m.target === target).map(m => m.srcPos)).size;
  if (CFG.MAX_POS_PER_TOKEN_PER_WALLET && perWallet >= CFG.MAX_POS_PER_TOKEN_PER_WALLET)
    return log(`  [${tag}] skip: already ${perWallet} open mirror(s) of this ticker from this wallet (cap ${CFG.MAX_POS_PER_TOKEN_PER_WALLET})`);
  const globalTicker = new Set(openMirrors.map(m => m.srcPos)).size;
  if (CFG.MAX_POS_PER_TOKEN_GLOBAL && globalTicker >= CFG.MAX_POS_PER_TOKEN_GLOBAL)
    return log(`  [${tag}] skip: already ${globalTicker} open mirror(s) of this ticker across all wallets (cap ${CFG.MAX_POS_PER_TOKEN_GLOBAL})`);
  const churnCap = TCFG[target]?.churnCap != null ? TCFG[target].churnCap : CFG.MAX_OPENS_PER_MINT;   // v0.6.20 per-wallet override
  if (churnCap) {
    const winMs = CFG.MINT_OPEN_WINDOW_MIN * 60000;
    const since = Date.now() - winMs;
    // counts every mirror we opened on this mint inside the window — open OR already closed,
    // any source wallet — so rapid source cycling can't re-enter us over and over.
    // v0.6.20: one open per SOURCE POSITION (chunks of one wide mirror are not separate opens)
    const recent = new Set(Object.values(S.mine).filter(m => m.mint === src.tokenX && m.ts >= since).map(m => (m.target || "") + ":" + (m.srcPos || m.ts))).size;
    if (recent >= churnCap)
      return log(`  [${tag}] skip: ${recent} open(s) on this mint in last ${CFG.MINT_OPEN_WINDOW_MIN}m (rate cap ${churnCap}) — churn guard`);
  }
  if (S.paused?.[target]) return log(`  [${tag}] skip: target paused`);
  const cdLeft = hardSlCooldownLeft(src.tokenX);
  if (cdLeft > 0) {
    const c = S.slCooldown[src.tokenX];
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: hard-SL cooldown on this token (${c.pnl}% stop ${((Date.now() - c.at) / 60000).toFixed(0)}m ago) — ${Math.ceil(cdLeft / 60000)}m left`);
  }
  const spLeft = spikeBlockLeft(src.pool);
  if (spLeft > 0)
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: fee spike on this pool (${S.spikePools[src.pool].rate}%/30m) — opens blocked ${Math.ceil(spLeft / 60000)}m more`);
  const sv = screenerVerdict(src.pool, target);
  if (sv.why && (sv.mode === "veto" || sv.mode === "strict"))
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${sv.why} [scr-gate ${sv.mode}]`);
  if (sv.tag) log(`  [${tag}] scr-gate ${sv.mode}: ${sv.tag.state === "listed" ? `${sv.tag.tier} pace4h ${sv.tag.pace4}% mom ${sv.tag.mom}` : sv.tag.state}${sv.why ? ` — WOULD skip: ${sv.why}` : " — pass"}`);
  const scrTag = sv.tag ? { ...sv.tag, mode: sv.mode, wouldBlock: sv.why, at: Date.now() } : null;
  const q = await tokenGate(src.tokenX, TCFG[target] || {});
  if (!q.ok) return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${q.why}`);
  if (q.note) log(`  [${tag}] note: ${q.note}`);
  if (q.lowMcap) log(`  [${tag}] low-mcap coin ($${(q.mcap / 1e6).toFixed(2)}M < $${CFG.MIN_MCAP_USD / 1e6}M) — sizing down to ${(TCFG[target] || {}).lowMcapSol} SOL fixed`);
  const fg = await poolFeeGate(src.pool, TCFG[target] || {});
  if (!fg.ok) return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${fg.why}`);
  if (fg.note) log(`  [${tag}] note: ${fg.note}`);
  if (fg.pct !== undefined) log(`  [${tag}] pool fee/TVL ${fg.pct.toFixed(2)}%/24h — pass`);

  // chain read: the source position itself
  const dlmm = await getDlmm(src.pool);
  await withRetry(() => dlmm.refetchStates(), "refetch").catch(() => {});
  const activeId = dlmm.lbPair.activeId;
  const step = dlmm.lbPair.binStep;
  let p;
  try { p = await withRetry(() => dlmm.getPosition(new PublicKey(src.pos)), "getPosition"); }
  catch (e) { return log(`  [${tag}] skip: cannot read source position (${e.message.slice(0, 60)})`); }
  const d = p.positionData;
  const lower = d.lowerBinId, upper = d.upperBinId;
  const xAmt = Number(d.totalXAmount), yAmt = Number(d.totalYAmount);
  const ySol = yAmt / LAMPORTS_PER_SOL;

  // single-sided SOL by VALUE SHARE, not zero-tolerance: a bid ladder price has
  // already dipped into carries some token X from early fills — still copyable.
  const px = src.poolPrice || 0; // Y per X
  const xValSol = px > 0 ? (xAmt * px) / LAMPORTS_PER_SOL : 0;
  const totalValSol = ySol + xValSol;
  const maxTokSide = (TCFG[target]?.maxTokSidePct ?? 30) / 100;   // v0.6.22 per-wallet tokside=N override
  if (totalValSol > 0 && xValSol / totalValSol > maxTokSide)
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: token side is ${(100 * xValSol / totalValSol).toFixed(0)}% of value — not a fresh bid ladder (tokside cap ${(maxTokSide * 100).toFixed(0)}%)`);
  if (xValSol / (totalValSol || 1) > 0.30) log(`  [${tag}] two-sided source (${(100 * xValSol / totalValSol).toFixed(0)}% token) — copying its SOL side below price only`);
  const minDep = TCFG[target]?.minDep ?? CFG.MIN_TARGET_DEPOSIT_SOL;
  if (totalValSol < minDep * 0.98) // 2% tolerance: deposits of exactly the min read a hair under from lamport/price rounding
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${totalValSol.toFixed(2)} SOL < ${minDep} min`);
  // clamp our copy to the part still below price; skip only if nothing usable remains
  if (lower >= activeId)
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: entire range already above/at price (fully filled)`);
  const effUpper = Math.min(upper, activeId - 1);
  const widthPct = (1 - (1 + step / 10000) ** (lower - upper)) * 100;
  const remainPct = (1 - (1 + step / 10000) ** (lower - effUpper)) * 100;
  if (widthPct < CFG.MIN_PRICE_RANGE_PCT) return log(`  [${tag}] skip: range ${widthPct.toFixed(1)}% < ${CFG.MIN_PRICE_RANGE_PCT}%`);
  // tiered width FLOOR-AS-MODIFICATION: narrow source ladders aren't skipped — OUR mirror is
  // extended downward to the tier's minimum width (top stays anchored at their placement, the
  // added depth goes below price). 7d study: <45% net-negative everywhere; sub-2M needs 60%+.
  // Unknown mcap -> strict tier.
  let widenToBins = 0, widthFloor = 0, widthTierLabel = "";
  const widthSource = (TCFG[target] || {}).width === "source";
  if (widthSource) log(`  [${tag}] width=source — mirroring their exact ladder (no width floor / depth extension)`);
  else {
    const smallCap = q.mcap == null || (CFG.MIN_WIDTH_MCAP_USD > 0 && q.mcap < CFG.MIN_WIDTH_MCAP_USD);
    widthFloor = smallCap ? CFG.MIN_WIDTH_LOWCAP_PCT : CFG.MIN_WIDTH_PCT;
    widthTierLabel = smallCap ? `mcap ${q.mcap != null ? "$" + (q.mcap / 1e6).toFixed(2) + "M" : "unknown"} < $${CFG.MIN_WIDTH_MCAP_USD / 1e6}M tier` : "standard tier";
    if (widthFloor > 0)
      widenToBins = Math.min(CFG.MAX_WIDEN_BINS,
        Math.ceil(-Math.log(1 - widthFloor / 100) / Math.log(1 + step / 10000)));
  }
  if (remainPct < Math.max(1, widthPct * 0.4))
    return log(`  [${tag}] skip: only ${remainPct.toFixed(1)}% of their ${widthPct.toFixed(1)}% range still below price`);
  if (effUpper < upper) log(`  [${tag}] note: price inside their range — copying the below-price ${remainPct.toFixed(1)}% remainder`);

  // sizing: low-mcap downsize > per-target fixed > per-target pct > global mode
  const tOv = TCFG[target] || {};
  let sol = q.lowMcap ? tOv.lowMcapSol
    : tOv.fixedSol
    ?? (tOv.pct != null ? ySol * tOv.pct / 100
        : CFG.COPY_MODE === "fixed" ? CFG.COPY_FIXED_SOL : ySol * CFG.COPY_RATIO_PCT / 100);
  // explicit fixed size is its own authority — global cap applies only to computed sizes
  sol = Math.min(sol, tOv.maxSol ?? (tOv.fixedSol ? tOv.fixedSol : CFG.MAX_COPY_SOL));
  // per-mint exposure cap: one token's gap risk is bounded no matter how many targets pile in.
  // Correlated entries are one trade wearing several wallets' clothes — cap the TOKEN, not the target.
  const allowCap = CFG.AGE_ALLOWLIST[src.tokenX] ?? null;
  const mintCap = allowCap != null && CFG.MAX_MINT_SOL > 0 ? Math.min(allowCap, CFG.MAX_MINT_SOL)
                : allowCap != null ? allowCap : CFG.MAX_MINT_SOL;
  if (mintCap > 0) {
    const mintExposure = Object.values(S.mine)
      .filter(x => !x.closed && x.mint === src.tokenX)
      .reduce((a, x) => a + (x.solIn || 0), 0);
    const headroom = mintCap - mintExposure;
    if (headroom < CFG.MIN_OPEN_SOL)
      return log(`  [${tag}] skip: mint exposure ${mintExposure.toFixed(0)}/${mintCap} SOL — cap reached`);
    if (sol > headroom) {
      log(`  [${tag}] mint exposure ${mintExposure.toFixed(0)}/${mintCap} SOL — downsizing ${sol.toFixed(1)} -> ${headroom.toFixed(1)}`);
      sol = headroom;
    }
  }
  // GROUP BUDGET: cap this group's combined open exposure at its % of total equity.
  // Exposure is cost basis (solIn) of open positions whose target carries the same group tag;
  // equity = wallet balance + cost basis of ALL open positions. Sized like the mint cap:
  // downsize into headroom, skip when the group is full.
  // GROUP BUDGET: cap this group's combined open exposure (SOL cost basis) at a fixed SOL amount.
  const grpName = tOv.group;
  const budget = grpName != null ? CFG.GROUP_BUDGETS[grpName] : null;
  let _balSol = null;
  if (budget > 0 && !CFG.GROUP_RES_ONLY.has(grpName)) { // res-only groups have no ceiling — spill into free balance
    let grpOpen = 0;
    for (const x of Object.values(S.mine))
      if (!x.closed && (TCFG[x.target] || {}).group === grpName) grpOpen += x.solIn || 0;
    const headroom = budget - grpOpen;
    if (headroom < CFG.MIN_OPEN_SOL)
      return log(`  [${tag}] skip: group '${grpName}' exposure ${grpOpen.toFixed(1)}/${budget} SOL — budget full`);
    if (sol > headroom) {
      log(`  [${tag}] group '${grpName}' ${grpOpen.toFixed(1)}/${budget} SOL — downsizing ${sol.toFixed(1)} -> ${headroom.toFixed(1)}`);
      sol = headroom;
    }
  }
  if (!CFG.DRY_RUN) {
    // balance-aware sizing: never miss a signal for lack of full size — downsize to what the
    // wallet can fund while keeping SOL_RESERVE liquid for fees/rent, AND keeping every OTHER
    // budget group's unused reserve fenced off (reservation + ceiling semantics: a group's
    // allocation is always available to its members). Skip only below MIN_OPEN_SOL.
    const bal = _balSol ?? await conn.getBalance(signer.publicKey) / LAMPORTS_PER_SOL;
    let reservedForOthers = 0;
    const grpNames = Object.keys(CFG.GROUP_BUDGETS);
    if (grpNames.length) {
      const openByGroup = {};
      for (const x of Object.values(S.mine)) {
        if (x.closed) continue;
        const g = (TCFG[x.target] || {}).group;
        if (g != null) openByGroup[g] = (openByGroup[g] || 0) + (x.solIn || 0);
      }
      for (const g of grpNames) {
        if (g === grpName) continue;                        // members draw freely from their own reserve
        if (CFG.GROUP_CAP_ONLY.has(g)) continue;            // cap-only groups (name:Ncap) reserve nothing
        reservedForOthers += Math.max(0, CFG.GROUP_BUDGETS[g] - (openByGroup[g] || 0));
      }
    }
    const available = bal - CFG.SOL_RESERVE - reservedForOthers;
    if (available < sol) {
      if (available < CFG.MIN_OPEN_SOL)
        return log(`  [${tag}] skip: balance ${bal.toFixed(2)} SOL leaves ${available.toFixed(2)} after ${CFG.SOL_RESERVE} reserve${reservedForOthers > 0 ? ` + ${reservedForOthers.toFixed(1)} reserved for budget groups` : ""} — below ${CFG.MIN_OPEN_SOL} minimum`);
      log(`  [${tag}] downsizing ${sol.toFixed(1)} -> ${available.toFixed(1)} SOL (balance ${bal.toFixed(2)}, ${CFG.SOL_RESERVE} reserve${reservedForOthers > 0 ? `, ${reservedForOthers.toFixed(1)} reserved for groups` : ""})`);
      sol = available;
    }
  }
  const binsForDrop = pct => Math.ceil(Math.log(1 / (1 - pct / 100)) / Math.log(1 + step / 10000));
  let minBin = lower, maxBin = effUpper; // full width mirrored — multi-position when > 69 bins
  if (widenToBins > maxBin - minBin + 1) {
    const newMin = maxBin - widenToBins + 1;
    const ourPct = (1 - (1 + step / 10000) ** (minBin - maxBin - 1)) * 100;
    const newPct = (1 - (1 + step / 10000) ** (newMin - maxBin - 1)) * 100;
    log(`  [${tag}] widening: our ladder ${ourPct.toFixed(1)}% < ${widthFloor}% floor (${widthTierLabel}) — extending ${minBin}..${maxBin} -> ${newMin}..${maxBin} (${newPct.toFixed(1)}% wide)`);
    minBin = newMin;
  }
  if (CFG.MIN_RANGE_DEPTH_PCT > 0 && !widthSource) {
    const depthFloor = activeId - binsForDrop(CFG.MIN_RANGE_DEPTH_PCT);
    if (minBin > depthFloor) {
      const srcDepth = (1 - (1 + step / 10000) ** (lower - activeId)) * 100;
      log(`  [${tag}] widening: source bottom -${srcDepth.toFixed(0)}% from price -> extending ours to -${CFG.MIN_RANGE_DEPTH_PCT}%`);
      minBin = depthFloor;
    }
  }

  // liquidity shape: mirror how THEY distributed within the range (Spot/BidAsk/Curve).
  // Detected from their per-bin share (already fetched above — no extra RPC). Wide multi-
  // position path stays BidAsk until live-verified unless SHAPE_ON_WIDE=true.
  const shape = CFG.SHAPE_MIRROR ? classifyShape(d.positionBinData, activeId)
                                 : { name: "BidAsk", strategyType: StrategyType.BidAsk, ratio: null };
  const wide = maxBin - minBin + 1 > 69;
  const applyShape = CFG.SHAPE_MIRROR && (!wide || CFG.SHAPE_ON_WIDE);
  const strategyType = applyShape ? shape.strategyType : StrategyType.BidAsk;
  if (CFG.SHAPE_MIRROR)
    log(`  [${tag}] shape: source=${shape.name}${shape.ratio != null ? ` (far/near ${shape.ratio.toFixed(2)})` : " (fallback)"}` +
        `${applyShape ? "" : ` — wide path unverified, opening BidAsk`}`);

  log(`  [${tag}] MIRROR ${src.pos.slice(0, 6)}: ${src.tokenX.slice(0, 6)}-SOL bins ${minBin}..${maxBin} (${widthPct.toFixed(1)}% wide), ` +
      `their ${ySol.toFixed(1)} SOL -> our ${sol.toFixed(2)} SOL [${applyShape ? shape.name : "BidAsk"}]` +
      (q.taxBps ? ` TAX ${(q.taxBps / 100).toFixed(2)}%/transfer (~${(2 * q.taxBps / 100).toFixed(1)}% round-trip if filled)` : ""));
  if (CFG.DRY_RUN) {
    const exd = (TCFG[target] || {}).extra;
    if (exd) log(`  [${tag}] [dry-run] would also open extra leg ${exd.name}: bins ${activeId - binsForDrop(exd.depth)}..${effUpper} ${exd.shape} ${sol.toFixed(2)} SOL`);
    log("  [dry-run] not sent"); return { dry: true };
  }

  // v0.6.23: placement of one leg (their mirrored range, or an extra fixed-shape leg)
  const placeLeg = async (minBin, maxBin, strategyType, shapeName, sol, legName) => {
    const totalY = new BN(Math.floor(sol * LAMPORTS_PER_SOL));
    const strategy = { minBinId: minBin, maxBinId: maxBin, strategyType };
    const legShape = shapeName;
    const opened = [];
    if (maxBin - minBin + 1 <= 69) {
      // single atomic tx (init + add together) — any failure is a clean failure, so the
      // 0x1774 active-bin slippage race is retried unconditionally with doubled tolerance
      for (let attempt = 0; ; attempt++) {
        const slip = Math.min(CFG.WIDE_SLIPPAGE_PCT * 2 ** attempt, 100);
        const posKp = Keypair.generate();
        registerPending(posKp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: legShape });
        try {
          const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: posKp.publicKey, user: signer.publicKey,
            totalXAmount: new BN(0), totalYAmount: totalY, strategy, slippage: slip,
          });
          await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer, posKp], { commitment: "confirmed" }), "open send");
          opened.push(posKp.publicKey.toBase58());
          break;
        } catch (e) {
          // transient RPC failures (gateway hiccups, blockhash races, rate limits): the tx did not
          // land — retry the build+send in place instead of losing the mirror to a 2-second outage
          const transient = /simulation failed|bad upstream|blockhash|node is behind|429|too many requests|rate.?limit|timed out|fetch failed|econn|socket hang/i.test(e.message || "");
          if (transient && attempt < 3) {
            const landedT = await dlmm.getPosition(posKp.publicKey).catch(() => null);
            if (!landedT) {
              log(`  [${tag}] transient RPC error (${(e.message || "").slice(0, 60)}) — retry ${attempt + 1}/3 in ${1.5 * (attempt + 1)}s`);
              await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
              await dlmm.refetchStates().catch(() => {});
              continue;
            }
          }
          // late-land reconciliation: "Transaction was not confirmed" often means it DID land,
          // just slower than the confirmation window. If the position exists on-chain, it is
          // OURS and we know exactly what it mirrors — record it with full linkage instead of
          // throwing it to the orphan sweep (which strips target/srcPos and kills follow=source).
          const landed = await dlmm.getPosition(posKp.publicKey).catch(() => null);
          if (landed) {
            log(`  [${tag}] open confirmed late — recording with linkage instead of orphaning`);
            opened.push(posKp.publicKey.toBase58());
            break;
          }
          const slipErr = /0x1774|ExceededBinSlippage/i.test(e.message || "");
          if (slipErr && attempt < 2) {
            log(`  [${tag}] active-bin slippage race at ${slip}% tolerance — rebuilding at ${Math.min(slip * 2, 100)}% and retrying`);
            await dlmm.refetchStates().catch(() => {});
            continue;
          }
          throw e;
        }
      }
    } else {
      // wide range: v2 multi-position builder returns pre-grouped tx batches in correct order.
      // Active-bin slippage races (0x1774 ExceededBinSlippageTolerance) are retried with a fresh
      // build and doubled tolerance — but ONLY when nothing landed (clean failure). If liquidity
      // is already on-chain we bail and let the orphan sweep adopt it rather than double-deposit.
      for (let attempt = 0; ; attempt++) {
        const slip = Math.min(CFG.WIDE_SLIPPAGE_PCT * 2 ** attempt, 100);
        const generatedKps = [];
        let cleanFailure = false;
        let enteredChunks = false;   // false => failure happened in the builder, nothing on-chain
        try {
          const resp = await dlmm.initializeMultiplePositionAndAddLiquidityByStrategy2(
            async n => { const kps = Array.from({ length: n }, () => Keypair.generate()); generatedKps.push(...kps);
              for (const kp of kps) registerPending(kp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: legShape });
              return kps; },
            new BN(0), totalY, strategy, signer.publicKey, signer.publicKey, slip);
          for (const part of resp.instructionsByPositions) {
            enteredChunks = true;
            const chunkAddr = part.positionKeypair.publicKey.toBase58();
            try {
              for (let gi = 0; gi < part.transactionInstructions.length; gi++) {
                const tx = new Transaction().add(...part.transactionInstructions[gi]);
                // sign with exactly the keypairs this tx's instructions demand
                const required = new Set();
                for (const ix of tx.instructions) for (const k of ix.keys) if (k.isSigner) required.add(k.pubkey.toBase58());
                const signers = [signer, ...generatedKps.filter(kp => required.has(kp.publicKey.toBase58()))];
                await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), signers, { commitment: "confirmed" }), `multi tx ${gi + 1}/${part.transactionInstructions.length}`);
              }
            } catch (e) {
              log(`  chunk failed mid-sequence — attempting husk cleanup (${e.message.slice(0, 60)})`);
              let landedWithLiquidity = false;
              // vanish-vs-transport discipline (same as closeMine v0.5.1): in a hot pool the init tx
              // can be CONFIRMED while the next read hasn't caught up yet — a failed/lagged read is
              // NOT proof the chunk never landed. Poll the raw account up to 3x over ~6s; only an
              // explicit account-not-found means "never landed" (allowing rebuild). If the account
              // EXISTS, this chunk is ours: record it with linkage even when the parsed read glitches.
              let exists = null; // true / false(explicit null) / null(unknown after retries)
              for (let ri = 0; ri < 3 && exists === null; ri++) {
                if (ri) await new Promise(r => setTimeout(r, 2000));
                const ai = await conn.getAccountInfo(part.positionKeypair.publicKey).catch(() => undefined);
                if (ai === null) exists = false;
                else if (ai) exists = true;
              }
              if (exists === false) { cleanFailure = true; log(`  chunk ${chunkAddr.slice(0, 8)}… never landed (account absent) — clean failure, rebuild allowed`); }
              else if (exists === true) {
                // account exists at an address only we generated -> it is OURS. Default to recording;
                // only an EMPTY husk that we successfully reclaim is treated as a clean failure.
                landedWithLiquidity = true;
                try {
                  const hp = await dlmm.getPosition(part.positionKeypair.publicKey).catch(() => null);
                  if (hp) {
                    const ctx = await dlmm.closePositionIfEmpty({ owner: signer.publicKey, position: hp });
                    if (ctx) { await sendAndConfirmTransaction(conn, withPriority(ctx), [signer], { commitment: "confirmed" }); cleanFailure = true; landedWithLiquidity = false; log(`  empty husk reclaimed`); }
                  } else log(`  chunk ${chunkAddr.slice(0, 8)}… exists but parsed read glitched — recording anyway`);
                } catch (hx) { log(`  husk check error (${(hx.message || "").slice(0, 60)}) — account exists, recording anyway`); landedWithLiquidity = true; }
              }
              if (exists === null) { log(`  chunk ${chunkAddr.slice(0, 8)}… state UNKNOWN after retries — not rebuilding (registry will link it if it landed)`); throw e; }
              if (landedWithLiquidity) {
                // late-land reconciliation: record with full linkage instead of abandoning to the
                // orphan sweep. Liquidity may be partial if a later add-liquidity tx in this
                // chunk's sequence dropped — still exit-managed AND source-followed this way.
                log(`  chunk ${chunkAddr.slice(0, 8)}… landed despite confirmation failure — recording with linkage`);
                opened.push(chunkAddr);
                S.mine[chunkAddr] = { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX,
                  minBin, maxBin, step, solIn: sol / resp.instructionsByPositions.length,
                  shape: legShape,
                  ts: Date.now(), oorSince: null, closed: false };
                save();
                continue; // move on to the next chunk — do not abort the ladder
              }
              throw e;
            }
            opened.push(chunkAddr); pendingChunks.delete(chunkAddr);
            S.mine[chunkAddr] = { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX,
              minBin, maxBin, step, solIn: sol / resp.instructionsByPositions.length,
              shape: legShape,
              ts: Date.now(), oorSince: null, closed: false };
            save();
            log(`  [${tag}] chunk opened ${chunkAddr.slice(0, 8)}…`);
          }
          break; // all chunks landed
        } catch (e) {
          const slipErr = /0x1774|ExceededBinSlippage/i.test(e.message || "");
          // builder-stage failure (!enteredChunks) is clean by definition: no tx was ever sent
          if (slipErr && (cleanFailure || !enteredChunks) && opened.length === 0 && attempt < 2) {
            log(`  [${tag}] active-bin slippage race at ${slip}% tolerance — rebuilding at ${Math.min(slip * 2, 100)}% and retrying`);
            await dlmm.refetchStates().catch(() => {});
            continue;
          }
          throw e;
        }
      }
    }
    log(`  [${tag}] OPENED ${opened.length} position account(s) covering bins ${minBin}..${maxBin}${legName !== "src" ? ` [extra leg ${legName}]` : ""}`);
    for (const addr of opened) {
      const e = (S.mine[addr] = S.mine[addr] || { pool: src.pool, mint: src.tokenX, minBin, maxBin, step, ts: Date.now(), oorSince: null, closed: false });
      // ALWAYS (re)write linkage: if the orphan sweep adopted this address seconds before we got here,
      // the entry exists with target=null — the old `||` kept that and silently orphaned the position.
      e.target = target; e.srcPos = src.pos; e.orphan = false; e.closed = false;
      if (e.minBin == null) { e.minBin = minBin; e.maxBin = maxBin; e.step = step; }
      pendingChunks.delete(addr);
      e.shape = legShape;
      e.leg = legName;                                         // v0.6.23 which leg of a dual copy (src | bidask50 ...)
      e.solIn = sol / opened.length;
      if (scrTag) e.scrTag = scrTag;
      e.siblings = opened.length > 1 ? opened.filter(a => a !== addr) : [];
      if (TCFG[target]?.followAdds && legName === "src") {
        const primary = addr === opened[0];
        e.addPrimary = primary;
        if (primary) { const sn = snapSrcBins(d.positionBinData); e.srcSnap = sn.bins; e.srcVal = sn.total; e.srcDepSol = null; } // deposit baseline set on first adds check (datapi)
      }
    }
    save();
    await calibrateChunks(dlmm, opened, minBin, maxBin).catch(e => log(`  chunk calibration error: ${(e.message || "").slice(0, 80)}`)); // v0.6.19
  };
  await placeLeg(minBin, maxBin, strategyType, applyShape ? shape.name : "BidAsk", sol, "src");
  // v0.6.23 extra=bidask:50 -> a SECOND position on the same source, same size: BidAsk from their top
  // (below price) down to -50% from price. Closed together with the source (same srcPos).
  const ex = (TCFG[target] || {}).extra;
  if (ex) {
    const exMin = activeId - binsForDrop(ex.depth), exMax = effUpper;
    if (exMin >= exMax) log(`  [${tag}] extra leg ${ex.name}: range empty — skipped`);
    else {
      log(`  [${tag}] MIRROR extra leg ${ex.name}: bins ${exMin}..${exMax} (${ex.depth}% deep from price) ${ex.shape} ${sol.toFixed(2)} SOL`);
      try { await placeLeg(exMin, exMax, StrategyType[ex.shape], ex.shape, sol, ex.name); }
      catch (e) { log(`  [${tag}] extra leg ${ex.name} failed: ${(e.message || "").slice(0, 90)} — main leg stays open`); }
    }
  }
}

async function ultraSellAll(mint, _retried = false) {
  // balance read races the just-confirmed withdraw across the RPC fleet — retry before concluding "nothing to sell"
  let bal = 0n;
  for (let read = 0; read < 3; read++) {
    const r0 = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) }).catch(() => null);
    bal = 0n;
    for (const a of r0?.value || []) bal += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    if (bal > 0n) { if (read > 0) log(`  sell: balance appeared on read ${read + 1} (rpc lag)`); break; }
    if (read < 2) await new Promise(s => setTimeout(s, 1500));
  }
  if (bal === 0n) return "none";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const u = `${CFG.JUP}/ultra/v1/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${bal}&taker=${signer.publicKey.toBase58()}`;
    const r = await jfetch(u).then(x => x.json()).catch(() => ({}));
    if (!r.transaction) { log("  sell: no route", JSON.stringify(r).slice(0, 100)); return "noroute"; }
    if (+r.outAmount < 2_000_000) { // < 0.002 SOL out: dust, a swap tx costs more than it returns
      log(`  sell: skipping dust (${(+r.outAmount / 1e9).toFixed(6)} SOL out) — not worth a transaction`); return "dust"; }
    const tx = VersionedTransaction.deserialize(Buffer.from(r.transaction, "base64"));
    tx.sign([signer]);
    const res = await jfetch(`${CFG.JUP}/ultra/v1/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: r.requestId }),
    }).then(x => x.json()).catch(() => ({}));
    if (res.status === "Success") {
      log(`  sold fills via ultra ${res.signature}`);
      ledgerRecord(res.signature);
      // trust but verify: partial fills and rpc-lag both exit "Success" with tokens left behind.
      // One balance re-read (1 rpc call); a meaningful remainder gets one recursive retry,
      // anything smaller waits for the janitor.
      if (!_retried) {
        await new Promise(s => setTimeout(s, 2500));
        const rv = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) }).catch(() => null);
        let left = 0n;
        for (const a of rv?.value || []) left += BigInt(a.account.data.parsed.info.tokenAmount.amount);
        if (left > 0n && left * 20n > bal) { // >5% of what we just tried to sell = not rounding dust
          log(`  sell: ${(Number(left) / Number(bal) * 100).toFixed(0)}% of bag still in wallet after Success — retrying remainder`);
          return ultraSellAll(mint, true);
        }
      }
      return "sold";
    }
    log(`  sell attempt ${attempt}/2 failed: ${JSON.stringify(res).slice(0, 100)}`);
    await new Promise(s => setTimeout(s, 2000));
  }
  log("  sell: giving up — tokens remain in wallet, will be swept with the next close on this mint");
  return "failed";
}


const WSOL = SOL_MINT;
// janitor: hourly sweep of WALLET balances on every mint the bot has ever traded.
// Wallet balance is exit residue or claimed fees by definition — position liquidity lives in
// position accounts, never the wallet — so sweeping is always safe, open positions or not.
// Catches rpc-lag misses, partial fills, gave-up sells, and accumulated sub-floor dust.
let lastJanitor = 0;
// dust cleanup: burn the crumbs AND close the account(s) in one transaction, so it either fully
// happens or nothing changes. Re-checks "is this token in use" right before sending.
function mintBusy(mint) {
  return Object.values(S.mine).some(m => !m.closed && m.mint === mint)
      || (_inflightMint.get(mint) || 0) > 0
      || [...pendingChunks.values()].some(p => p.mint === mint);
}
async function burnAndCloseDust(mint) {
  if (mintBusy(mint)) return { status: "busy" };
  const r = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) });
  if (!r.value.length) return { status: "none" };
  const { createBurnCheckedInstruction, createCloseAccountInstruction } = require("@solana/spl-token");
  const tx = new Transaction();
  let rent = 0;
  for (const a of r.value) {
    const info = a.account.data.parsed.info, prog = a.account.owner;
    if (info.state === "frozen") throw new Error("token account is frozen");
    const amt = BigInt(info.tokenAmount.amount);
    if (amt > 0n) tx.add(createBurnCheckedInstruction(a.pubkey, new PublicKey(mint), signer.publicKey, amt, info.tokenAmount.decimals, [], prog));
    tx.add(createCloseAccountInstruction(a.pubkey, signer.publicKey, signer.publicKey, [], prog));
    rent += a.account.lamports / LAMPORTS_PER_SOL;
  }
  if (mintBusy(mint)) return { status: "busy" };                  // last look before sending
  if (CFG.DRY_RUN) { log(`  janitor: [dry-run] would burn dust + close ${r.value.length} account(s) of ${mint.slice(0, 6)}…`); return { status: "dry" }; }
  await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  return { status: "closed", rent, n: r.value.length };
}
async function walletJanitor() {
  if (Date.now() - lastJanitor < CFG.JANITOR_MIN * 60_000) return;
  lastJanitor = Date.now();
  const openMints = new Set(Object.values(S.mine).filter(m => !m.closed).map(m => m.mint));
  const touched   = new Set(Object.values(S.mine).map(m => m.mint));
  const lastOpen  = {};
  for (const m of Object.values(S.mine)) if (m.mint && (m.ts || 0) > (lastOpen[m.mint] || 0)) lastOpen[m.mint] = m.ts || 0;
  S.janitorClean = S.janitorClean || {};   // mint -> ts cleaned (retired token, nothing left, account closed)
  S.janitorSkip  = S.janitorSkip  || {};   // mint -> { at, until, why } (no route / cleanup failed)
  let cleaned = 0, rentBack = 0, dirty = false;
  for (const mint of touched) {
    if (mint === SOL_MINT || !mint) continue;
    const retired = !openMints.has(mint);
    const reopened = t => (lastOpen[mint] || 0) > t;             // bot traded this token again since
    if (retired && S.janitorClean[mint] && !reopened(S.janitorClean[mint])) continue;   // done: no rpc
    const sk = S.janitorSkip[mint];
    if (retired && sk && sk.until > Date.now() && !reopened(sk.at)) continue;
    if (S.janitorClean[mint] && reopened(S.janitorClean[mint])) { delete S.janitorClean[mint]; dirty = true; }
    try {
      const r = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) });
      let bal = 0n; const empties = [];
      for (const a of r.value) {
        const amt = BigInt(a.account.data.parsed.info.tokenAmount.amount);
        if (amt === 0n) empties.push(a); else bal += amt;
      }
      if (bal > 0n) {
        log(`  janitor: leftover ${mint.slice(0, 6)}… in wallet — sweeping`);
        const res = await ledgerRun({ mint }, () => ultraSellAll(mint));
        if (!retired) continue;                                   // live token: never burn, just sell what sells
        if (res === "dust") {
          try {
            const x = await ledgerRun({ mint }, () => burnAndCloseDust(mint));
            if (x.status === "closed") {
              S.janitorClean[mint] = Date.now(); dirty = true; cleaned += x.n; rentBack += x.rent;
              log(`  janitor: burned dust + closed ${x.n} account(s) of ${mint.slice(0, 6)}… (+${x.rent.toFixed(4)} SOL rent back)`);
            }
          } catch (e) {
            S.janitorSkip[mint] = { at: Date.now(), until: Date.now() + 30 * 86400e3, why: (e.message || "").slice(0, 60) }; dirty = true;
            log(`  janitor: couldn't clean ${mint.slice(0, 6)}… (${(e.message || "").slice(0, 60)}) — leaving it, won't retry`);
          }
        } else if (res === "noroute") {
          S.janitorSkip[mint] = { at: Date.now(), until: Date.now() + 86400e3, why: "no route" }; dirty = true; // never burned; re-quote daily
        }
      } else if (retired) {                                       // reclaim ATA rent on fully-retired mints only
        if (!r.value.length) { S.janitorClean[mint] = Date.now(); dirty = true; continue; }
        if (mintBusy(mint) || CFG.DRY_RUN) continue;
        const { createCloseAccountInstruction } = require("@solana/spl-token");
        let ok = true;
        for (const a of empties) {
          const tx = new Transaction().add(createCloseAccountInstruction(a.pubkey, signer.publicKey, signer.publicKey, [], a.account.owner));
          await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" })
            .then(() => { cleaned++; rentBack += a.account.lamports / LAMPORTS_PER_SOL; })
            .catch(() => { ok = false; });
        }
        if (ok) { S.janitorClean[mint] = Date.now(); dirty = true; }
      }
    } catch {}
  }
  if (cleaned) log(`  janitor: ${cleaned} token account(s) closed this sweep, ~${rentBack.toFixed(4)} SOL rent reclaimed`);
  if (dirty) save();
  await unwrapWsol();
}

async function unwrapWsol() {
  try {
    const r = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(WSOL) });
    for (const a of r.value) {
      if (BigInt(a.account.data.parsed.info.tokenAmount.amount) === 0n) continue;
      const { createCloseAccountInstruction } = require("@solana/spl-token");
      const tx = new Transaction().add(createCloseAccountInstruction(a.pubkey, signer.publicKey, signer.publicKey));
      await withRetry(() => sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" }), "unwrap wsol");
      log("  unwrapped wSOL to native");
    }
  } catch (e) { log("  wsol unwrap skipped:", e.message.slice(0, 60)); }
}

async function claimFees(addr, m, minSol = CFG.FEE_CLAIM_MIN_SOL) {
  return ledgerRun({ pool: m.pool, mint: m.mint, target: m.target }, () => claimFeesImpl(addr, m, minSol));
}
async function claimFeesImpl(addr, m, minSol = CFG.FEE_CLAIM_MIN_SOL) {
  try {
    const dlmm = await getDlmm(m.pool);
    const p = await withRetry(() => dlmm.getPosition(new PublicKey(addr)), "getPosition");
    // exact per-position gate: the tick-level trigger splits pool fees equally across our
    // positions, which misallocates when we hold several in one pool — verify before claiming
    const price = parseFloat(getPriceOfBinByBinId(dlmm.lbPair.activeId, dlmm.lbPair.binStep).toString()); // lbPair refreshed by the tick batch
    const dueSol = (Number(p.positionData.feeX) * price + Number(p.positionData.feeY)) / LAMPORTS_PER_SOL;
    if (dueSol < minSol) {
      log(`  claim ${addr.slice(0, 8)}…: actual unclaimed ${dueSol.toFixed(3)} SOL < ${minSol} — recheck in ${CFG.FEE_CLAIM_HOURS}h`);
      return;
    }
    // claim everything: swap fees AND LM rewards (datapi unclaimed totals include both)
    const txs = await dlmm.claimAllRewardsByPosition({ owner: signer.publicKey, position: p });
    for (const tx of Array.isArray(txs) ? txs : [txs])
      await withRetry(() => sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" }), "claim send");
    log(`  claimed ~${dueSol.toFixed(3)} SOL fees/rewards on ${addr.slice(0, 8)}…`);
    // bank the claim at its REALIZED value: these fees are sold to SOL moments from now, so
    // their worth is locked here — never re-marked at whatever the token trades at later
    m.feesClaimedRealSol = (m.feesClaimedRealSol || 0) + dueSol; save();
    await ultraSellAll(m.mint);   // token-side fees -> SOL immediately
    await unwrapWsol();           // SOL-side fees -> native
  } catch (e) {
    log(`  claim ${addr.slice(0, 8)}…: ${e.message.slice(0, 80)} — next attempt in ${CFG.FEE_CLAIM_HOURS}h`);
  } finally {
    m.lastClaim = Date.now(); save(); // success or not, don't spin every tick on the same position
  }
}

const closingNow = new Set(); // re-entry guard: fast-guard and main tick can race on the same position

// exits fight for blockspace exactly when pools are melting — pay up to land.
// Skips if the SDK already attached a unit-price ix (duplicate ComputeBudget types abort the tx).
function withPriority(tx) {
  if (!(CFG.PRIORITY_FEE_MICRO > 0) || !tx?.instructions) return tx;
  const hasPrice = tx.instructions.some(ix =>
    ix.programId.equals(ComputeBudgetProgram.programId) && ix.data?.[0] === 3 /* SetComputeUnitPrice */);
  if (!hasPrice) tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(CFG.PRIORITY_FEE_MICRO) }));
  return tx;
}
async function closeMine(addr, m, reason, opts = {}) {
  return ledgerRun({ pool: m.pool, mint: m.mint, target: m.target }, async () => {
    const r = await closeMineImpl(addr, m, reason, opts);
    if (m.closed) ledgerEndIfFlat(m);
    return r;
  });
}
async function closeMineImpl(addr, m, reason, opts = {}) {
  if (m.closed || closingNow.has(addr)) return;
  closingNow.add(addr);
  try {
  const pk = +m.peakPnl, lp = +m.lastPnl;
  const gb = Number.isFinite(pk) && Number.isFinite(lp)
    ? ` | peak ${pk >= 0 ? "+" : ""}${pk.toFixed(1)}% -> exit ${lp >= 0 ? "+" : ""}${lp.toFixed(1)}% (giveback ${(pk - lp).toFixed(1)}pt)` : "";
  log(`  CLOSE ${addr.slice(0, 8)}… (${reason})${gb}`);
  if (CFG.DRY_RUN) { m.closed = true; save(); return log("  [dry-run] not executed"); }
  try {
    const dlmm = await getDlmm(m.pool);
    // vanish-vs-transport distinction: only treat the position as gone when the chain EXPLICITLY
    // says the account doesn't exist. A transport/RPC/proxy error here must ABORT the close and
    // leave the ledger open — marking closed on a failed read abandons a live position on-chain
    // with no stops (2026-09-02 incident: proxy auth outage phantom-closed live CTO positions).
    let p = null;
    try { p = await withRetry(() => dlmm.getPosition(new PublicKey(addr)), "getPosition"); }
    catch (e) {
      const acct = await conn.getAccountInfo(new PublicKey(addr)).catch(() => undefined);
      if (acct === null) p = null;                       // chain says: account truly gone
      else { log(`  close aborted — position read failed (${(e.message || "").slice(0, 70)}); will retry next trigger`); return; }
    }
    if (p) {
      const empty = String(p.positionData.totalXAmount) === "0" && String(p.positionData.totalYAmount) === "0";
      if (empty) {
        // husk: init landed, liquidity never did — nothing to withdraw, just reclaim rent
        const tx = await dlmm.closePositionIfEmpty({ owner: signer.publicKey, position: p });
        if (tx) await withRetry(() => sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" }), "husk close");
        log(`  empty position (husk) — rent reclaimed`);
      } else {
        const txs = await dlmm.removeLiquidity({
          position: new PublicKey(addr), user: signer.publicKey,
          fromBinId: p.positionData.lowerBinId, toBinId: p.positionData.upperBinId,
          bps: new BN(10000), shouldClaimAndClose: true,
        });
        for (const tx of Array.isArray(txs) ? txs : [txs])
          await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer], { commitment: "confirmed" }), "close send");
        log(`  withdrawn + closed`);
      }
    }
    if (!opts.skipSell) { await ultraSellAll(m.mint); await unwrapWsol(); }
    m.closed = true;
    if (m.target && m.lastPnl !== undefined) {
      S.stats = S.stats || {};
      const st = (S.stats[m.target] = S.stats[m.target] || { closed: 0, wins: 0, netPnlSol: 0, recent: [] });
      st.closed++; if (m.lastPnl > 0) st.wins++;
      st.netPnlSol += (m.solIn || 0) * (+m.lastPnl) / 100 + (m.trimPnlSol || 0);
      ledgerTrackerAdd(m, (m.solIn || 0) * (+m.lastPnl) / 100 + (m.trimPnlSol || 0));
      st.recent.push(+(+m.lastPnl).toFixed(2)); if (st.recent.length > 20) st.recent.shift();
      log(`  [${m.target.slice(0, 6)}] ledger: ${st.closed} closed, ${st.wins} wins (${(100 * st.wins / st.closed).toFixed(0)}%), net ${st.netPnlSol >= 0 ? "+" : ""}${st.netPnlSol.toFixed(2)} SOL`);
      if (CFG.AUTOPAUSE_AFTER > 0 && st.recent.length >= CFG.AUTOPAUSE_AFTER) {
        const lastN = st.recent.slice(-CFG.AUTOPAUSE_AFTER);
        if (lastN.reduce((a, b) => a + b, 0) < 0 && lastN.filter(x => x > 0).length < CFG.AUTOPAUSE_AFTER / 2) {
          S.paused = S.paused || {};
for (const m of Object.values(S.mine)) {
  if (m.peakPnl !== undefined) m.peakPnl = Number.isFinite(+m.peakPnl) ? +m.peakPnl : undefined;
  if (m.lastPnl !== undefined) m.lastPnl = Number.isFinite(+m.lastPnl) ? +m.lastPnl : undefined;
}
          if (!S.paused[m.target]) {
            S.paused[m.target] = { at: Date.now(), lastN };
            log(`AUTO-PAUSE [${m.target.slice(0, 6)}]: last ${CFG.AUTOPAUSE_AFTER} mirrors ${lastN.join("/")} — no new mirrors until unpaused`);
          }
        }
      }
    }
    save();
  } catch (e) { log(`  close error (will retry next tick): ${e.message.slice(0, 120)}`); }
  } finally { closingNow.delete(addr); }
}


// ---------------------------------------- realtime nudge (Helius WS) ------
// Any tx from a target touching the DLMM program triggers an immediate,
// short-retry poll of just that wallet — collapses detection from ~60s to seconds.
const LB_CLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const nudging = new Set();
async function nudge(wallet) {
  if (nudging.has(wallet)) return;
  nudging.add(wallet);
  try {
    const before = new Set(Object.keys(S.seen[wallet] || {}));
    for (let i = 0; i < 10; i++) {                    // up to ~30s for datapi to index
      await new Promise(r => setTimeout(r, 3000));
      let open; try { open = await openPositions(wallet); } catch { continue; }
      // v0.6.10: a NEVER-POLLED target must be baselined, not copied — without this, a wallet
      // event racing the first tick mirrored every PRE-EXISTING position of a freshly added
      // target (matt/CrJ incident: six old positions copied, budget blown, real opens blocked).
      if (!S.init[wallet]) {
        const seen = (S.seen[wallet] = S.seen[wallet] || {});
        for (const o of open) seen[o.pos] = true;
        S.init[wallet] = true; save();
        log(`baseline ${wallet.slice(0, 6)} (realtime): ${open.length} existing position(s) recorded, copying starts from new ones`);
        return;
      }
      // fast exits: any of our mirrors whose source position vanished -> close now
      await mirrorCloses(wallet, new Set(open.map(o => o.pos))).catch(e => log("  nudge close error:", e.message));
      const fresh = open.filter(o => !before.has(o.pos));
      if (fresh.length) {
        const seen = (S.seen[wallet] = S.seen[wallet] || {});
        for (const o of fresh) {
          if (seen[o.pos]) continue;
          seen[o.pos] = true; save();
          log(`[${wallet.slice(0, 6)}] NEW source position ${o.pos.slice(0, 8)}… (realtime)`);
          await mirrorOpen(wallet, o).catch(e => log("  mirror error:", e.message));
        }
        break;
      }
    }
  } finally { nudging.delete(wallet); }
}

let wsBackoff = 0;
let wsRef = null;
const poolSubs = new Map();   // pool -> { reqId, subId }
const subIdToPool = new Map();
const guardLast = new Map();  // pool -> last WS-dispatched guard ts (debounce)
const guardBusy = new Set();  // pools with a WS-dispatched guard in flight
let watchPools = new Set();   // ALL open-position pools — every one gets a realtime WS watch
let wsReqId = 10_000;
// keep WS pool subscriptions in sync with the danger set: pushed account data carries the
// full lbPair state, so activeId updates arrive in REAL TIME at zero rpc cost
function syncPoolSubs() {
  const ws = wsRef;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const pool of watchPools) {
    if (poolSubs.has(pool)) continue;
    const reqId = ++wsReqId;
    poolSubs.set(pool, { reqId, subId: null });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "accountSubscribe",
      params: [pool, { commitment: "confirmed", encoding: "base64" }] }));
  }
  for (const [pool, sub] of poolSubs) {
    if (watchPools.has(pool)) continue;
    if (sub.subId != null) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++wsReqId, method: "accountUnsubscribe", params: [sub.subId] }));
      subIdToPool.delete(sub.subId);
    }
    poolSubs.delete(pool);
  }
}

function connectWs() {
  const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${CFG.HELIUS_API_KEY}`);
  wsRef = ws;
  ws.on("open", () => {
    wsBackoff = 0;
    log(`WS nudge connected (${TARGETS.length} target subscriptions)`);
    TARGETS.forEach((t, i) => ws.send(JSON.stringify({
      jsonrpc: "2.0", id: i + 1, method: "logsSubscribe",
      params: [{ mentions: [t] }, { commitment: "confirmed" }],
    })));
    poolSubs.clear(); subIdToPool.clear(); // reconnect: resubscribe current danger set
    syncPoolSubs();
  });
  ws.on("message", raw => {
    try {
      const m = JSON.parse(raw);
      // subscription confirmations for our pool subs
      if (m?.id && m?.result != null) {
        for (const [pool, sub] of poolSubs) if (sub.reqId === m.id) { sub.subId = m.result; subIdToPool.set(m.result, pool); }
        return;
      }
      // real-time pool account update -> decode activeId locally, guard immediately.
      // Hot pools push many notifications per second; debounce to one guard dispatch
      // per pool per 2s and never run two guards on the same pool concurrently —
      // the decode itself stays real-time (free), only the rpc-costing guard is throttled.
      if (m?.method === "accountNotification") {
        const pool = subIdToPool.get(m.params?.subscription);
        const b64 = m.params?.result?.value?.data?.[0];
        if (!pool || !b64) return;
        const dl = dlmmCache.get(pool);
        if (!dl) return;
        const lbPair = decodeAccount(dl.program, "lbPair", Buffer.from(b64, "base64"));
        dl.lbPair = lbPair;
        const now = Date.now();
        lbFresh.set(pool, now);
        if (guardBusy.has(pool) || now - (guardLast.get(pool) || 0) < 2_000) return;
        guardLast.set(pool, now); guardBusy.add(pool);
        guardPool(pool, dl, lbPair.activeId).catch(() => {}).finally(() => guardBusy.delete(pool));
        return;
      }
      const v = m?.params?.result?.value;
      if (!v?.signature || v.err) return;
      const logs = (v.logs || []).join(" ");
      if (!logs.includes(LB_CLMM)) return;            // only DLMM program activity
      // we don't know which target fired from the sub id cheaply — nudge all (cheap, datapi)
      for (const t of TARGETS) nudge(t);
    } catch {}
  });
  const dead = () => { wsBackoff = Math.min((wsBackoff || 2000) * 2, 60_000); setTimeout(connectWs, wsBackoff); };
  ws.on("close", dead);
  ws.on("error", e => log("ws error:", e.message));
  const hb = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
  ws.on("close", () => clearInterval(hb));
}


async function positionPnls(pool, wallet) {
  const r = await fetch(`${CFG.DATAPI}/positions/${pool}/pnl?user=${wallet}&status=open&page_size=100`, { headers: UA });
  if (!r.ok) throw new Error(`pnl api ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const p of j.data || []) {
    out[p.positionAddress] = {
      pnlSolPct: p.pnlSolPctChange != null ? +p.pnlSolPctChange : null,
      lowerBinId: p.lowerBinId, upperBinId: p.upperBinId, activeBinId: p.poolActiveBinId,
      inRange: p.poolActiveBinId >= p.lowerBinId && p.poolActiveBinId <= p.upperBinId,
      below: p.poolActiveBinId < p.lowerBinId,   // fully filled, holding tokens
      above: p.poolActiveBinId > p.upperBinId,   // all SOL, unfilled/emptied
    };
  }
  return out;
}


async function mirrorCloses(wallet, nowSet) {
  for (const [ourAddr, m] of Object.entries(S.mine)) {
    if (m.closed || m.target !== wallet || !m.srcPos) continue;
    if (!nowSet.has(m.srcPos)) await closeMine(ourAddr, m, "source wallet closed theirs");
  }
}

// ------------------------------------------------------------- main loop ---
// fee-inclusive chain-truth pnl: position value + unclaimed fees + lifetime-claimed fees
// (chain-tracked on the position account), vs deposit. TokenX legs valued at current active-bin price.
// ---- ladder chunks (copylp v0.6.19) ----------------------------------------------------------------
// members of the same ladder: this entry + its recorded siblings that are still open
function ladderMembers(addr, m) {
  const out = [[addr, m]];
  for (const a of m.siblings || []) { const s = S.mine[a]; if (s && !s.closed) out.push([a, s]); }
  return out;
}
// "top" of a ladder for above-range checks = highest bin of the chunks still open
function effTop(addr, m) {
  if (m.cMax == null) return m.maxBin;
  let top = null;
  for (const [, s] of ladderMembers(addr, m)) { const t = s.cMax ?? s.maxBin; if (t != null && (top == null || t > top)) top = t; }
  return top ?? m.maxBin;
}
function ladderKey(addr, m) { return m.ladderId || [addr, ...(m.siblings || [])].sort()[0]; }
// whole-ladder pnl from each open chunk's last chain read (same pass window); own pnl if a sibling is stale
function ladderPnl(addr, m, pnl) {
  const mem = ladderMembers(addr, m);
  if (mem.length < 2) return { pnl, sibs: [] };
  const sibs = mem.slice(1);
  let val = 0, basis = 0;
  for (const [, s] of mem) {
    if (!(s.solIn > 0) || s.lastValSol == null || Date.now() - (s.lastValAt || 0) > 20 * 60_000) return { pnl, sibs };
    val += s.lastValSol; basis += s.solIn;
  }
  return { pnl: basis > 0 ? (val / basis - 1) * 100 : pnl, sibs, whole: true };
}
// read each chunk's REAL bins and deposit from chain right after opening
async function calibrateChunks(dlmm, addrs, ladderMin, ladderMax) {
  const price = parseFloat(getPriceOfBinByBinId(dlmm.lbPair.activeId, dlmm.lbPair.binStep).toString());
  const lid = addrs[0];
  for (const a of addrs) {
    const e = S.mine[a]; if (!e) continue;
    e.ladderId = lid; e.ladderMin = ladderMin; e.ladderMax = ladderMax;
    if (addrs.length < 2) { e.cMin = e.minBin; e.cMax = e.maxBin; continue; }
    let d = null;
    for (let i = 0; i < 3 && !d; i++) {
      if (i) await new Promise(r => setTimeout(r, 2000));
      d = await dlmm.getPosition(new PublicKey(a)).then(p => p.positionData).catch(() => null);
    }
    if (!d) { log(`  chunk ${a.slice(0, 8)}…: couldn't read back its bins/deposit — keeping the even split`); continue; }
    e.cMin = d.lowerBinId; e.cMax = d.upperBinId;
    const v = (Number(d.totalXAmount) * price + Number(d.totalYAmount)) / LAMPORTS_PER_SOL;
    if (v > 0) e.solIn = v;
  }
  if (addrs.length > 1) log(`  ladder split into ${addrs.length} chunks: ` + addrs.map(a => { const e = S.mine[a] || {}; return `${a.slice(0, 6)} bins ${e.cMin}..${e.cMax} ${(+e.solIn || 0).toFixed(3)} SOL`; }).join(" | "));
  save();
}
// boot repair for chunk groups opened by older builds (equal split + whole-ladder bins)
async function repairChunkGroups() {
  const groups = {};
  for (const [a, m] of Object.entries(S.mine))
    if (!m.closed && (m.siblings || []).length && m.cMin == null) (groups[ladderKey(a, m)] = groups[ladderKey(a, m)] || []).push([a, m]);
  const keys = Object.keys(groups);
  if (!keys.length) return;
  log(`chunk repair: ${keys.length} ladder(s) from older builds — reading real chunk bins/deposits`);
  for (const k of keys) {
    const list = groups[k];
    const m0 = list[0][1];
    try {
      const dl = await getDlmm(m0.pool); await dl.refetchStates().catch(() => {});
      const price = parseFloat(getPriceOfBinByBinId(dl.lbPair.activeId, dl.lbPair.binStep).toString());
      const reads = [];
      for (const [a, m] of list) {
        const d = await dl.getPosition(new PublicKey(a)).then(p => p.positionData).catch(() => null);
        if (!d) continue;
        m.cMin = d.lowerBinId; m.cMax = d.upperBinId; m.ladderMin = m.ladderMin ?? m.minBin; m.ladderMax = m.ladderMax ?? m.maxBin; m.ladderId = k;
        reads.push({ a, m, x: Number(d.totalXAmount), v: (Number(d.totalXAmount) * price + Number(d.totalYAmount)) / LAMPORTS_PER_SOL });
      }
      const allMembers = [...new Set([list[0][0], ...(m0.siblings || [])])];
      const allOpen = allMembers.every(a => S.mine[a] && !S.mine[a].closed) && reads.length === allMembers.length;
      const touched = list.some(([, m]) => m.scrTrimmed || m.spikeTrimmed || m.trimPnlSol);
      const sumV = reads.reduce((s, r) => s + r.v, 0), sumB = list.reduce((s, [, m]) => s + (m.solIn || 0), 0);
      for (const r of reads) {
        const old = r.m.solIn;
        if (allOpen && !touched && sumV > 0) r.m.solIn = sumB * r.v / sumV;           // same total, split by real weight
        else if (r.x === 0 && r.v > 0) r.m.solIn = r.v;                                // untouched SOL-only chunk: basis = SOL held
        else { log(`  chunk ${r.a.slice(0, 8)}…: partly filled and siblings gone — basis left at ${(+old).toFixed(3)} SOL`); continue; }
        r.m.lastPnl = null; r.m.peakPnl = undefined; r.m.feesSnapTs = null;
        log(`  chunk ${r.a.slice(0, 8)}… (${r.m.scrSym || r.m.mint.slice(0, 6)}): bins ${r.m.cMin}..${r.m.cMax}, basis ${(+old).toFixed(3)} -> ${r.m.solIn.toFixed(3)} SOL`);
      }
      save();
    } catch (e) { log(`  chunk repair ${k.slice(0, 8)}… failed: ${(e.message || "").slice(0, 80)} — will retry next boot`); }
  }
}
async function chainPnl(dl, addr, m, activeId = null) {
  const p = await dl.getPosition(new PublicKey(addr));
  // price from binId is pure math — only fetch when no fresh activeId was handed in
  const price = activeId != null
    ? parseFloat(getPriceOfBinByBinId(activeId, dl.lbPair.binStep).toString())
    : parseFloat((await dl.getActiveBin()).price || "0");
  const d = p.positionData;
  const val = (Number(d.totalXAmount) * price + Number(d.totalYAmount)) / LAMPORTS_PER_SOL;
  // v0.6.22 basis guard: a position holding NO token yet can't be down — if its SOL value reads clearly below the
  // recorded deposit (part of the add never landed, e.g. Etedre Hg5Ja5 09-30: 21.1 of 30 SOL landed -> fake
  // -29.6% -> false hard stop), the recorded deposit is wrong. After 2 matching reads 3+ min in, reset it.
  if (Number(d.totalXAmount) === 0 && val > 0 && m.solIn > 0 && val < m.solIn * 0.97 && Date.now() - (m.ts || 0) > 3 * 60_000
      && !m.scrTrimmed && !m.trimPnlSol) {
    m.basisLowN = (m.basisLowN || 0) + 1;
    if (m.basisLowN >= 2) {
      log(`  basis fix ${addr.slice(0, 8)}…: holds no token but only ${val.toFixed(3)} of ${(+m.solIn).toFixed(3)} SOL is in the position — deposit corrected (part of the add never landed)`);
      m.solIn = val; m.basisFixed = Date.now(); m.basisLowN = 0; m.peakPnl = undefined;
    }
  } else if (m.basisLowN) m.basisLowN = 0;
  const unclaimed = (Number(d.feeX) * price + Number(d.feeY)) / LAMPORTS_PER_SOL;
  const claimed = m.feesClaimedRealSol != null
    ? m.feesClaimedRealSol // realized SOL, banked at claim time — immune to later price
    : (Number(d.totalClaimedFeeXAmount) * price + Number(d.totalClaimedFeeYAmount)) / LAMPORTS_PER_SOL;
  const fees = unclaimed + claimed - (m.feesBaseSol || 0);
  // fee-velocity bookkeeping: % of deposit earned per 30min, from snapshots >=20min apart
  // (first window measures from open — new hot pools count as hot from the start)
  const now = Date.now();
  if (!m.feesSnapTs) { m.feesSnapTs = m.ts; m.feesSnapSol = 0; }
  const elapsedMin = (now - m.feesSnapTs) / 60_000;
  if (elapsedMin >= 1 && m.solIn > 0) {
    m.hotFeePct30m = ((fees - m.feesSnapSol) / m.solIn) * 100 * (30 / elapsedMin);
    if (elapsedMin >= CFG.SPIKE_MIN_WINDOW_MIN) noteSpikeReading(m, m.hotFeePct30m, now);
  }
  if (elapsedMin >= 20) { m.feesSnapTs = now; m.feesSnapSol = fees; }
  m.lastValSol = val + fees; m.lastValAt = now;   // v0.6.19: for whole-ladder pnl across chunks
  return ((val + fees) / m.solIn - 1) * 100;
}
// stop decision, fee-velocity aware. A HOT position (earning >= HOT_FEE_30M_PCT of deposit
// per 30min) has the fee engine actively paying for its drawdown: it gets the deeper
// STOP_LOSS_HOT_PCT line and keeps wick-confirmation patience even below range. A COLD
// position gets the tight line, and out-of-range cold breaches close immediately — which is
// what a rug looks like: price out the bottom AND the fee printer stopped. The hard collapse
// line closes instantly everywhere, hot or not — that is the massive-selloff cap.
// ---- screener gate (0.6.16) ---------------------------------------------------------------------
const SCR_BLOCK_TIERS = new Set(CFG.SCREENER_GATE_BLOCK_TIERS.split(",").map(x => x.trim()).filter(Boolean));
const SCR_MODES = new Set(["off", "shadow", "veto", "strict"]);
let _scrCache = { at: 0, P: null, err: null }, _scrWarnAt = 0;
const SCR_REMOTE = /^https?:\/\//i.test(CFG.SCREENER_GATE_FILE);
let _scrFetching = null;
function fetchRemotePicks() {                                       // background refresh; resolves when done, never throws
  if (_scrFetching) return _scrFetching;
  _scrCache.at = Date.now();
  _scrFetching = fetch(CFG.SCREENER_GATE_FILE, { headers: { "x-picks-token": CFG.SCREENER_GATE_TOKEN, "cache-control": "no-cache" }, signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}${r.status === 404 ? " (wrong URL or token)" : ""}`)))
    .then(j => { if (!j || typeof j !== "object" || !j.pools) throw new Error("reply is not a picks file"); _scrCache.P = j; _scrCache.err = null; })
    .catch(e => { _scrCache.err = (e.name === "TimeoutError" ? "timeout — server/port unreachable (firewall?)"
                    : e.cause?.code ? `${e.cause.code} — server/port unreachable` : e.message || String(e)).slice(0, 90); })
    .finally(() => { _scrFetching = null; });
  return _scrFetching;
}
function screenerPicks() {
  if (!CFG.SCREENER_GATE_FILE) return null;
  if (SCR_REMOTE) { if (Date.now() - _scrCache.at >= 30_000) fetchRemotePicks(); return _scrCache.P; } // last good copy; age checked by caller
  if (Date.now() - _scrCache.at < 30_000) return _scrCache.P;       // the screener rewrites the file every few minutes
  _scrCache.at = Date.now();
  try { _scrCache.P = JSON.parse(fs.readFileSync(CFG.SCREENER_GATE_FILE, "utf8")); _scrCache.err = null; }
  catch (e) { _scrCache.err = e.message; }                          // keep the last good copy; staleness check handles age
  return _scrCache.P;
}
function scrModeFor(target) {
  const m = (TCFG[target] || {}).scrGate || CFG.SCREENER_GATE;
  return SCR_MODES.has(m) ? m : "off";
}
// -> { mode, tag, why } ; why = reason the gate blocks (or WOULD block, in shadow), null = pass
function screenerVerdict(pool, target) {
  const mode = scrModeFor(target);
  if (mode === "off") return { mode, tag: null, why: null };
  const P = screenerPicks();
  const warn = msg => { if (Date.now() - _scrWarnAt > 30 * 60_000) { _scrWarnAt = Date.now(); log(`  [scr-gate] ${msg} — gate stepping aside, copying as normal`); } };
  if (!P) { warn(`can't read picks (${_scrCache.err || "SCREENER_GATE_FILE not set"})`); return { mode, tag: { state: "no-file" }, why: null }; }
  const ageMin = (Date.now() / 1000 - (P.ts || 0)) / 60;
  if (!(ageMin <= CFG.SCREENER_GATE_MAX_AGE_MIN)) { warn(`picks are ${ageMin.toFixed(0)} min old (screener down?)`); return { mode, tag: { state: "stale", ageMin: Math.round(ageMin) }, why: null }; }
  const p = (P.pools || {})[pool];
  if (!p) return { mode, tag: { state: "unlisted" }, why: mode === "strict" ? "pool not in the screener's picks (strict)" : null };
  const tag = { state: "listed", tier: p.plus ? "CORE+" : p.tier, pace4: p.pace4 ?? null, mom: p.mom ?? null,
                slowN: p.slowN || 0, fadeN: p.fadeN || 0, streak: p.streak ?? null };
  let why = null;
  if (p.tier === "GONE") { if ((p.gone || 0) >= 2 && SCR_BLOCK_TIERS.has("GONE")) why = `screener: left its filters ${p.gone} passes ago`; }
  else if (SCR_BLOCK_TIERS.has(p.tier)) why = `screener says ${p.tier.replace("SKIP-", "")} (pace4h ${p.pace4}%, mom ${p.mom})`;
  if (!why && CFG.SCREENER_GATE_MAX_PACE > 0 && +p.pace4 > CFG.SCREENER_GATE_MAX_PACE) why = `screener pace4h ${p.pace4}%/day > ${CFG.SCREENER_GATE_MAX_PACE}% ceiling`;
  return { mode, tag, why };
}

// ---- fee-spike de-risk (0.6.15) --------------------------------------------------------------
// a reading only counts when measured over >= SPIKE_MIN_WINDOW_MIN; the spike state goes stale
// if not re-confirmed within 3 check intervals (min 15m), so one old reading can't act forever
function noteSpikeReading(m, rate, now = Date.now()) {
  m.spikeRate = +(+rate).toFixed(3); m.spikeRateAt = now;
  if (CFG.SPIKE_FEE_30M_PCT > 0 && rate >= CFG.SPIKE_FEE_30M_PCT && m.pool) {
    const prev = S.spikePools[m.pool];
    if (!prev || prev.until < now) log(`  [spike] ${m.pool.slice(0, 6)}… fees ${rate.toFixed(2)}%/30m on ${(m.mint || "").slice(0, 6)} — new opens/adds on this pool blocked while it stays hot`);
    S.spikePools[m.pool] = { until: now + CFG.SPIKE_BLOCK_MIN * 60_000, rate: +(+rate).toFixed(3) };
  }
}
function isSpiking(m) {
  if (!(CFG.SPIKE_FEE_30M_PCT > 0) || m.spikeRate == null || !m.spikeRateAt) return false;
  const fresh = Date.now() - m.spikeRateAt <= Math.max(3 * CFG.SPIKE_CHECK_MIN, 15) * 60_000;
  return fresh && m.spikeRate >= CFG.SPIKE_FEE_30M_PCT;
}
function spikeBlockLeft(pool) {
  const c = S.spikePools[pool];
  if (!c) return 0;
  const left = c.until - Date.now();
  if (left <= 0) { delete S.spikePools[pool]; save(); return 0; }
  return left;
}
// withdraw pct% of a position's liquidity (fees stay in place — claim separately), sell the token
// side, and rescale the ledger so % pnl is continuous: basis and fee baseline shrink by the same
// share, the trimmed share's pnl is booked into m.trimPnlSol for the per-target ledger.
async function trimPosition(addr, m, pct, reason) {
  return ledgerRun({ pool: m.pool, mint: m.mint, target: m.target }, () => trimPositionImpl(addr, m, pct, reason));
}
async function trimPositionImpl(addr, m, pct, reason) {
  if (m.closed || closingNow.has(addr) || !(pct > 0 && pct < 100)) return false;
  closingNow.add(addr);
  try {
    log(`  TRIM ${pct}% ${addr.slice(0, 8)}… (${reason})`);
    if (CFG.DRY_RUN) { m.spikeTrimmed = Date.now(); save(); log("  [dry-run] not executed"); return true; }
    const dlmm = await getDlmm(m.pool);
    const p = await withRetry(() => dlmm.getPosition(new PublicKey(addr)), "getPosition");
    const d = p.positionData;
    if (String(d.totalXAmount) === "0" && String(d.totalYAmount) === "0") { log("  trim skipped — position empty"); return false; }
    const price = parseFloat(getPriceOfBinByBinId(dlmm.lbPair.activeId, dlmm.lbPair.binStep).toString());
    const unclaimed = (Number(d.feeX) * price + Number(d.feeY)) / LAMPORTS_PER_SOL;
    const claimed = m.feesClaimedRealSol != null ? m.feesClaimedRealSol
      : (Number(d.totalClaimedFeeXAmount) * price + Number(d.totalClaimedFeeYAmount)) / LAMPORTS_PER_SOL;
    const fees = unclaimed + claimed - (m.feesBaseSol || 0);
    const txs = await dlmm.removeLiquidity({
      position: new PublicKey(addr), user: signer.publicKey,
      fromBinId: d.lowerBinId, toBinId: d.upperBinId,
      bps: new BN(Math.round(pct * 100)), shouldClaimAndClose: false,
    });
    for (const tx of Array.isArray(txs) ? txs : [txs])
      await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer], { commitment: "confirmed" }), "trim send");
    const f = pct / 100, pnlNow = Number.isFinite(+m.lastPnl) ? +m.lastPnl : 0;
    m.trimPnlSol = (m.trimPnlSol || 0) + m.solIn * f * pnlNow / 100;
    m.feesBaseSol = (m.feesBaseSol || 0) + f * fees;
    m.solIn = m.solIn * (1 - f);
    m.feesSnapTs = Date.now(); m.feesSnapSol = fees * (1 - f);
    m.spikeTrimmed = Date.now(); save();
    log(`  trimmed — basis now ${m.solIn.toFixed(2)} SOL`);
    await ultraSellAll(m.mint); await unwrapWsol();
    return true;
  } catch (e) { log(`  trim error (retried while still spiking): ${e.message.slice(0, 100)}`); return false; }
  finally { closingNow.delete(addr); }
}
// staged response for a SPIKING position; returns "closed" when the position was exited
async function spikeManage(addr, m, pnl) {
  const tag = `${(m.target || "orphan").slice(0, 6)}`;
  const why = `fees ${(+m.spikeRate).toFixed(2)}%/30m, pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`;
  if (pnl <= CFG.SPIKE_EXIT_PNL) {
    await closeMine(addr, m, `fee-spike exit: ${why} <= ${CFG.SPIKE_EXIT_PNL}%`);
    return m.closed ? "closed" : null;
  }
  // stage 1 (always while spiking): lock fees, at most once per block window
  if (Date.now() - (m.spikeClaimAt || 0) >= CFG.SPIKE_BLOCK_MIN * 60_000) {
    m.spikeClaimAt = Date.now(); save();
    log(`  [${tag}] spike on ${addr.slice(0, 8)}… (${why}) — claiming fees`);
    await claimFees(addr, m, CFG.SPIKE_CLAIM_MIN_SOL);
  }
  // stage 2: price already moving into the ladder -> cut size once
  if (CFG.SPIKE_TRIM_PCT > 0 && !m.spikeTrimmed && pnl <= CFG.SPIKE_TRIM_PNL && m.solIn >= CFG.SPIKE_TRIM_MIN_SOL)
    await trimPosition(addr, m, CFG.SPIKE_TRIM_PCT, `fee-spike trim: ${why} <= ${CFG.SPIKE_TRIM_PNL}%`);
  return null;
}
// hard-SL cooldown: a token that just blew through the collapse line gets no new opens for
// HARD_SL_COOLDOWN_MIN, from any wallet. Armed at decision time (both main loop and fast-guard
// route through slShouldClose), keyed by mint, persisted so a restart can't re-enter the knife.
function armHardSlCooldown(m, pnl) {
  if (!(CFG.HARD_SL_COOLDOWN_MIN > 0) || !m.mint) return;
  const until = Date.now() + CFG.HARD_SL_COOLDOWN_MIN * 60_000;
  const cur = S.slCooldown[m.mint];
  if (cur && cur.until >= until - 60_000) return; // already armed this minute — no log spam on burst exits
  S.slCooldown[m.mint] = { until, at: Date.now(), pnl: +(+pnl).toFixed(1), target: m.target || null };
  save();
  log(`  [cooldown] hard stop ${(+pnl).toFixed(1)}% on ${m.mint.slice(0, 8)}… — new opens on this token blocked for ${CFG.HARD_SL_COOLDOWN_MIN}min (until ${new Date(until).toISOString().slice(11, 16)} UTC)`);
}
function hardSlCooldownLeft(mint) {
  const c = S.slCooldown[mint];
  if (!c) return 0;
  const left = c.until - Date.now();
  if (left <= 0) { delete S.slCooldown[mint]; save(); return 0; }
  return left;
}
function slShouldClose(m, pnl, inRange) {
  const o = slCfgFor(m.target);
  // hard collapse line: instant, unconditional, independent of the soft stop (which may be off)
  if (o.hard > 0 && pnl <= -o.hard) { armHardSlCooldown(m, pnl); return true; }
  const hot = CFG.HOT_FEE_30M_PCT > 0 && (m.hotFeePct30m || 0) >= CFG.HOT_FEE_30M_PCT;
  const line = hot ? o.hot : o.sl;
  if (!(line > 0) || pnl > -line) { // line 0/off => soft stop disabled for this target
    if (m.slBreachSince) { m.slBreachSince = null; save(); }
    return false;
  }
  if (!inRange && !hot) return true;
  if (!(CFG.SL_CONFIRM_SECONDS > 0)) return true;
  if (!m.slBreachSince) { m.slBreachSince = Date.now(); save(); return false; }
  return Date.now() - m.slBreachSince >= CFG.SL_CONFIRM_SECONDS * 1000;
}
function stampPnl(m, v) {
  if (v == null || !Number.isFinite(+v)) return;
  m.lastPnl = +v;
  if (m.peakPnl === undefined || +v > +m.peakPnl) m.peakPnl = +v;
  save();
}

// ---- fast guard: 10s watch on pools where price is descending into our ladders.
// The 30s tick is too slow for meme knife moves; this loop checks ONLY danger pools
// (depthIn >= PNL_DEPTH_TRIGGER at last tick) and evaluates the SAME fee-inclusive pnl
// stop as the main loop, just faster. Depth decides where to look — pnl decides when to close.
let dangerPools = new Set();
let fastGuardRunning = false;
// shared guard: evaluate every position in a pool against a fresh activeId.
// Called by the 10s fast-guard loop AND by real-time WS pool notifications.
// When SEVERAL positions breach in the same pass (a crash condemns every ladder in the pool
// at once), exits go out as a PARALLEL BURST: all withdraws broadcast simultaneously, then
// ONE coalesced sell of the combined bag — queue position must not decide realized slippage.
async function guardPool(pool, dl, activeId) {
  const toClose = [];
  for (const [addr, m] of Object.entries(S.mine)) {
    if (m.closed || m.pool !== pool || m.minBin == null || m.maxBin == null || !(m.solIn > 0) || closingNow.has(addr)) continue;
    const below = activeId < m.minBin;
    const depthIn = m.maxBin > m.minBin ? (m.maxBin - activeId) / (m.maxBin - m.minBin) : 0;
    if (below && mirrorHold(m)) {
      if (!m.belowAt) {
        m.belowAt = Date.now(); save();
        if (CFG.HOLD_CLOSE_POS_PCT != null && Number.isFinite(+m.lastPnl) && +m.lastPnl > CFG.HOLD_CLOSE_POS_PCT) {
          toClose.push({ addr, m, reason: `fast-guard: filled through while positive (+${(+m.lastPnl).toFixed(1)}%) — locking the win` }); continue;
        }
      }
    } else if (!below && m.belowAt) { m.belowAt = null; save(); }
    if (below && CFG.AUTO_CLOSE_OOR_MIN === 0 && !mirrorHold(m)) {
      toClose.push({ addr, m, reason: "fast-guard: filled through, price below ladder" }); continue;
    }
    // chain-truth pnl watch: in-range positions descending into the ladder, AND riding
    // below-range bags under mirror-hold (pure token inventory — the -18 line's main customers).
    // ADAPTIVE CADENCE: read budget scales with danger. Distance above the effective stop line
    // (per-target: soft line if on, else hard) picks the interval — flat positions cost almost
    // nothing, positions near the line get every pass. Unknown pnl -> check immediately.
    if ((!below && depthIn >= CFG.PNL_DEPTH_TRIGGER) || (below && mirrorHold(m))) {
      const sinceCheck = Date.now() - (m.lastPnlCheck || 0);
      if (sinceCheck < 5_000) continue; // hard floor: WS storms on hot pools must not spam chainPnl
      const oSl = slCfgFor(m.target);
      const line = oSl.sl > 0 ? oSl.sl : oSl.hard;
      const gap = (m.lastPnl != null && line > 0) ? +m.lastPnl + line : null; // pct-points above the line
      const interval = gap == null ? 0
                     : gap <= 3 ? 5_000
                     : gap <= 6 ? 10_000
                     : gap <= 12 ? 30_000
                     : 120_000;
      // price-moved override (crash must beat comfort) applies only when already near the line —
      // on flat positions a busy tape must not re-enable the old every-pass burn
      const moved = m.lastCheckBin != null && Math.abs(activeId - m.lastCheckBin) >= CFG.GUARD_MOVE_BINS;
      if (sinceCheck < interval && !(moved && gap != null && gap <= 12)) continue;
      let pnl; try { pnl = await chainPnl(dl, addr, m, activeId); } catch { continue; }
      m.lastPnlCheck = Date.now(); m.lastCheckBin = activeId; stampPnl(m, pnl);
      const inR = activeId >= m.minBin && activeId <= m.maxBin;
      const wasHot = (m.hotFeePct30m || 0) >= CFG.HOT_FEE_30M_PCT;
      const lpG = ladderPnl(addr, m, pnl); pnl = lpG.pnl;                 // v0.6.19: whole-ladder pnl for chunks
      const slHit = slShouldClose(m, pnl, inR);
      if (slHit) for (const [a2, m2] of lpG.sibs)
        if (!m2.closed && !closingNow.has(a2) && !toClose.some(t => t.addr === a2)) toClose.push({ addr: a2, m: m2, reason: `fast-guard stop-loss ${pnl.toFixed(1)}% (whole ladder) — ladder chunk` });
      if (!slHit && isSpiking(m) && pnl <= CFG.SPIKE_EXIT_PNL) {
        toClose.push({ addr, m, reason: `fast-guard fee-spike exit: fees ${(+m.spikeRate).toFixed(2)}%/30m, pnl ${pnl.toFixed(1)}% <= ${CFG.SPIKE_EXIT_PNL}%` });
        continue;
      }
      if (slHit)
        toClose.push({ addr, m, reason: `fast-guard stop-loss ${pnl.toFixed(1)}% (fees included${wasHot ? `, hot ${(m.hotFeePct30m || 0).toFixed(2)}%/30m line -${slCfgFor(m.target).hot}%` : ""}${m.slBreachSince ? `, held ${((Date.now() - m.slBreachSince) / 1000).toFixed(0)}s` : ""})` });
    }
  }
  if (toClose.length === 0) return;
  if (toClose.length === 1) {
    const e = toClose[0];
    return closeMine(e.addr, e.m, e.reason);
  }
  // ---- parallel exit burst ----
  const mint = toClose[0].m.mint;
  log(`  BURST: ${toClose.length} positions in pool ${pool.slice(0, 6)}… breached together — parallel withdraws, coalesced sell`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    toClose.map(e => closeMine(e.addr, e.m, e.reason, { skipSell: true })));
  const failed = toClose.filter((e, i) => results[i].status === "rejected" || (!e.m.closed && !CFG.DRY_RUN));
  if (!CFG.DRY_RUN) {
    await ledgerRun({ mint }, () => ultraSellAll(mint)).catch(e => log(`  burst sell error: ${e.message.slice(0, 80)}`));
    await unwrapWsol();
  }
  log(`  BURST done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${toClose.length - failed.length}/${toClose.length} closed + sold as one order`
    + (failed.length ? ` — ${failed.length} still open (retried next pass): ${failed.map(e => e.addr.slice(0, 6)).join(", ")}` : ""));
}
async function fastGuard() {
  if (fastGuardRunning || dangerPools.size === 0) return;
  fastGuardRunning = true;
  try {
    for (const pool of dangerPools) {
      let dl, activeId;
      try {
        dl = await getDlmm(pool);
        // WS pushes every lbPair change in real time and the tick batch-reads all pools once
        // per POLL — if that copy is fresh, use it; the RPC read here was pure duplication.
        if (Date.now() - (lbFresh.get(pool) || 0) < LB_FRESH_MS && dl.lbPair?.activeId != null) activeId = dl.lbPair.activeId;
        else { activeId = (await dl.getActiveBin()).binId; lbFresh.set(pool, Date.now()); }
      } catch { continue; }
      await guardPool(pool, dl, activeId);
    }
  } finally { fastGuardRunning = false; }
}

async function tick() {
  const nextDanger = new Set();
  // 1) targets: detect new + closed source positions
  for (const w of TARGETS) {
    let open;
    try { open = await openPositions(w); }
    catch (e) { log(`datapi ${w.slice(0, 6)} error: ${e.message}`); continue; }
    const seen = (S.seen[w] = S.seen[w] || {});
    const nowSet = new Set(open.map(o => o.pos));
    lastSrcOpen[w] = nowSet;

    if (!S.init[w]) {
      // first ever poll for this wallet: baseline only, don't copy pre-existing positions
      for (const o of open) seen[o.pos] = true;
      S.init[w] = true; save();
      log(`baseline ${w.slice(0, 6)}: ${open.length} existing position(s) recorded, copying starts from new ones`);
      continue;
    }
    for (const o of open) {
      if (!seen[o.pos]) {
        seen[o.pos] = true; save();
        log(`[${w.slice(0, 6)}] NEW source position ${o.pos.slice(0, 8)}…`);
        await mirrorOpen(w, o).catch(e => log("  mirror error:", e.message));
      }
    }
    if (TCFG[w]?.followAdds) await followAdds(w, nowSet).catch(e => log(`adds ${w.slice(0, 6)} error: ${e.message}`));
    await mirrorCloses(w, nowSet);
  }

  // 2) our own book: per-POSITION stop-loss, OOR timers, fee claims (datapi, free)
  if (signer && !CFG.DRY_RUN && Object.values(S.mine).some(m => !m.closed)) {
    const me = signer.publicKey.toBase58();
    let mine;
    try { mine = await openPositions(me); } catch { mine = null; }
    if (mine) {
      // orphan sweep: adopt unknown on-chain positions; re-enrich blind ones
      // (an orphan without minBin/maxBin is invisible to the exit loop below —
      //  no SL, no OOR, no fee claims — so enrichment must eventually succeed)
      const enrichOrphan = async (posAddr, e) => {
        const dl = await getDlmm(e.pool);
        const p = await dl.getPosition(new PublicKey(posAddr));
        e.minBin = p.positionData.lowerBinId; e.maxBin = p.positionData.upperBinId;
        const act = await dl.getActiveBin();
        const price = parseFloat(act.price || "0");
        const xVal = Number(p.positionData.totalXAmount) * price;
        e.solIn = (xVal + Number(p.positionData.totalYAmount)) / LAMPORTS_PER_SOL; // adoption-time value as basis
        // fees earned before adoption aren't ours to count — snapshot them as the base
        e.feesBaseSol = ((Number(p.positionData.feeX) + Number(p.positionData.totalClaimedFeeXAmount)) * price
                       + Number(p.positionData.feeY) + Number(p.positionData.totalClaimedFeeYAmount)) / LAMPORTS_PER_SOL;
      };
      prunePending();
      for (const o of mine) {
        const known = S.mine[o.pos];
        const pend = pendingChunks.get(o.pos);
        if (known && known.orphan && !known.target && pend) {
          // earlier adoption lost the linkage — the registry knows whose chunk this is
          Object.assign(known, { target: pend.target, srcPos: pend.srcPos, minBin: known.minBin ?? pend.minBin, maxBin: known.maxBin ?? pend.maxBin, shape: pend.shape, orphan: false });
          pendingChunks.delete(o.pos); save();
          log(`LATE CHUNK relinked ${o.pos.slice(0, 8)}… -> ${pend.target.slice(0, 6)} (from pending registry)`);
          continue;
        }
        if (!known) {
          if (pend) {
            log(`LATE CHUNK adopted WITH linkage ${o.pos.slice(0, 8)}… -> ${pend.target.slice(0, 6)} (registry; open path lost it)`);
            const e = { target: pend.target, srcPos: pend.srcPos, pool: o.pool, mint: o.tokenX, step: o.binStep,
              minBin: pend.minBin, maxBin: pend.maxBin, shape: pend.shape, solIn: 0, ts: Date.now(), oorSince: null, closed: false, orphan: false };
            try { await enrichOrphan(o.pos, e); } catch (err) { log(`  enrich failed (retry next tick): ${err.message.slice(0, 60)}`); }
            S.mine[o.pos] = e; pendingChunks.delete(o.pos); save();
            continue;
          }
          log(`ORPHAN adopted ${o.pos.slice(0, 8)}… (on-chain but not in ledger)`);
          const e = { target: null, srcPos: null, pool: o.pool, mint: o.tokenX,
            step: o.binStep, solIn: 0, ts: Date.now(), oorSince: null, closed: false, orphan: true };
          try { await enrichOrphan(o.pos, e); }
          catch (err) { log(`  adoption enrich failed (will retry next tick): ${err.message.slice(0, 60)}`); }
          S.mine[o.pos] = e; save();
        } else if (known.orphan && !known.closed && known.minBin == null) {
          try {
            await enrichOrphan(o.pos, known); save();
            log(`ORPHAN re-enriched ${o.pos.slice(0, 8)}…: bins ${known.minBin}..${known.maxBin}, basis ${known.solIn.toFixed(2)} SOL — now exit-managed`);
          } catch (err) { log(`  orphan enrich ${o.pos.slice(0, 8)}… failed: ${err.message.slice(0, 60)}`); }
        }
      }
      const poolFeeRow = Object.fromEntries(mine.map(o => [o.pool, o])); // pool aggregates for fee claims
      const pools = [...new Set(Object.values(S.mine).filter(m => !m.closed).map(m => m.pool))];
      // datapi per-position pnl if it serves rows (self-healing preference), else chain fallback
      const pnlByPool = {};
      for (const pool of pools) {
        try { const r = await positionPnls(pool, me); if (Object.keys(r).length) pnlByPool[pool] = r; } catch {}
      }
      // pool active state: ONE batched account read for all pools per tick (the exit loop only
      // needs activeId). Full refetchStates costs ~5 rpc calls per pool and is reserved for opens.
      const activeByPool = {};
      try {
        const dls = await Promise.all(pools.map(p => getDlmm(p).catch(() => null)));
        const infos = await conn.getMultipleAccountsInfo(pools.map(p => new PublicKey(p)));
        pools.forEach((pool, i) => {
          if (!dls[i] || !infos[i]) return;
          const lbPair = decodeAccount(dls[i].program, "lbPair", infos[i].data);
          dls[i].lbPair = lbPair; // keep cached instance roughly current
          lbFresh.set(pool, Date.now());
          activeByPool[pool] = { activeId: lbPair.activeId, dl: dls[i] };
        });
      } catch (e) { // fallback: old per-pool refresh path
        log(`batched pool read failed (${e.message.slice(0, 40)}) — falling back to per-pool refetch`);
        for (const pool of pools) {
          try {
            const dl = await getDlmm(pool);
            await withRetry(() => dl.refetchStates(), "refetch").catch(() => {});
            activeByPool[pool] = { activeId: dl.lbPair.activeId, dl };
          } catch (e2) { log(`pool state ${pool.slice(0, 6)} error: ${e2.message.slice(0, 60)}`); }
        }
      }
      if (!Object.keys(pnlByPool).length && !S._pnlWarned) {
        log("NOTE: datapi per-position pnl endpoint returning no rows — running on chain-truth fallback");
        S._pnlWarned = true;
      }
      for (const [addr, m] of Object.entries(S.mine)) {
        if (m.closed) continue;
        // ---- orphan policy: no source linkage means no follow and no mirror-close, ever.
        if (!m.target && m.minBin != null) { // enriched (bins known) -> closeable
          const ageH = (Date.now() - (m.ts || 0)) / 3.6e6;
          if (CFG.ORPHAN_POLICY === "close") { await closeMine(addr, m, "orphan policy=close (no source linkage)"); continue; }
          if (CFG.ORPHAN_MAX_AGE_H > 0 && ageH >= CFG.ORPHAN_MAX_AGE_H) { await closeMine(addr, m, `orphan max age ${ageH.toFixed(1)}h >= ${CFG.ORPHAN_MAX_AGE_H}h`); continue; }
          if (CFG.ORPHAN_TP_PCT > 0 && m.lastPnl != null && m.lastPnl >= CFG.ORPHAN_TP_PCT) { await closeMine(addr, m, `orphan take-profit ${m.lastPnl.toFixed(1)}% >= ${CFG.ORPHAN_TP_PCT}%`); continue; }
        }
        const ap = activeByPool[m.pool];
        const dpRow = pnlByPool[m.pool]?.[addr];
        // range state: prefer datapi row, else stored range vs chain active bin
        let below, above, inRange;
        if (dpRow) { below = dpRow.below; above = dpRow.above; inRange = dpRow.inRange; }
        else if (ap && m.minBin != null && m.maxBin != null) {
          below = ap.activeId < m.minBin; above = ap.activeId > effTop(addr, m); inRange = !below && !above; // v0.6.19: chunk-aware top
        } else continue;

        // ladder depth: 0 = price at our top bin, 1 = at our bottom bin.
        // Depth only routes attention (danger set -> fast pnl checks) — closes are pnl-decided.
        const depthIn = (ap && m.minBin != null && m.maxBin > m.minBin)
          ? (m.maxBin - ap.activeId) / (m.maxBin - m.minBin) : null;
        if (depthIn != null && inRange && depthIn >= CFG.PNL_DEPTH_TRIGGER) nextDanger.add(m.pool);

        // pnl: datapi if present; else chain valuation only when at-risk (below range, or pool aggregate ugly,
        // or price has descended into the lower part of our ladder — heavy fills, drawdown building while
        // technically still "in range"). Plus a slow heartbeat so nothing bleeds invisibly for hours.
        // datapi pnl is deliberately NOT used for stop decisions, even now that the endpoint
        // is back (Aug 2026): stops require the chain-truth fee-inclusive basis, and the
        // hot-fee-velocity metric is stamped inside chainPnl — short-circuiting it would
        // silently degrade the hot/cold logic. datapi serves analytics only.
        let pnl = null;
        if (pnl == null && ap && m.solIn > 0) {
          const poolAgg = +poolFeeRow[m.pool]?.pnlSolPctChange;
          const throttleOk = Date.now() - (m.lastPnlCheck || 0) >= CFG.PNL_CHECK_SECONDS * 1000;
          const heartbeat  = Date.now() - (m.lastPnlCheck || m.ts) >= CFG.PNL_HEARTBEAT_MIN * 60_000;
          const suspicious = below
            || (Number.isFinite(poolAgg) && (() => { const o = slCfgFor(m.target); const l = o.sl > 0 ? o.sl : o.hard; return l > 0 && poolAgg <= -(l * 0.5); })())
            || (inRange && depthIn != null && depthIn >= CFG.PNL_DEPTH_TRIGGER);
          const spikeDue = CFG.SPIKE_FEE_30M_PCT > 0 && Date.now() - (m.lastPnlCheck || m.ts) >= CFG.SPIKE_CHECK_MIN * 60_000;
          if ((suspicious && throttleOk) || heartbeat || spikeDue) {
            m.lastPnlCheck = Date.now();
            try { pnl = await chainPnl(ap.dl, addr, m, ap.activeId); } catch {}
          }
        }
        if (pnl != null && Number.isFinite(+pnl)) {
          const v = +pnl;
          m.lastPnl = v;
          if (m.peakPnl === undefined || v > +m.peakPnl) m.peakPnl = v;
          save();
        }
        // stale-ladder max-age: an above-range ladder that has barely earned in MAX_UNTOUCHED_AGE_H
        // hours is dead capital, even if price grazed the top bin now and then (a graze stamps
        // wasInRange and endlessly resets the OOR-up timer — the economic test cuts through that).
        // Never-touched ladders close without a chain read; grazed ones get their lifetime fees
        // checked on-chain at most once an hour.
        if (CFG.MAX_UNTOUCHED_AGE_H > 0 && above && !mirrorHold(m)
            && Date.now() - m.ts > CFG.MAX_UNTOUCHED_AGE_H * 3600_000) {
          const ageH = ((Date.now() - m.ts) / 3600_000).toFixed(1);
          if (!m.wasInRange) {
            await closeMine(addr, m, `untouched ladder for ${ageH}h — freeing capital`);
            continue;
          }
          if (m.solIn > 0 && ap && Date.now() - (m.lastStaleCheck || 0) > 3600_000) {
            m.lastStaleCheck = Date.now(); save();
            try {
              const p = await ap.dl.getPosition(new PublicKey(addr));
              const price = parseFloat(getPriceOfBinByBinId(ap.activeId, ap.dl.lbPair.binStep).toString());
              const d = p.positionData;
              const fees = ((Number(d.feeX) + Number(d.totalClaimedFeeXAmount)) * price
                          + Number(d.feeY) + Number(d.totalClaimedFeeYAmount)) / LAMPORTS_PER_SOL
                          - (m.feesBaseSol || 0);
              if (fees / m.solIn < CFG.STALE_FEE_PCT / 100) {
                await closeMine(addr, m, `stale ladder: ${ageH}h old, lifetime fees ${(100 * fees / m.solIn).toFixed(2)}% < ${CFG.STALE_FEE_PCT}% — freeing capital`);
                continue;
              }
            } catch {}
          }
        }
        if (inRange && !m.wasInRange) { m.wasInRange = true; save(); }

        const lp = (pnl != null && Number.isFinite(+pnl)) ? ladderPnl(addr, m, +pnl) : null;   // v0.6.19: whole-ladder pnl for chunks
        if (lp && slShouldClose(m, lp.pnl, inRange)) {
          const why = `stop-loss ${lp.pnl.toFixed(1)}%${lp.whole ? " (whole ladder)" : ""} (fees included${inRange && m.slBreachSince ? `, held ${((Date.now() - m.slBreachSince) / 1000).toFixed(0)}s` : ""})`;
          await closeMine(addr, m, why);
          for (const [a2, m2] of lp.sibs) if (!m2.closed && !closingNow.has(a2)) await closeMine(a2, m2, why + " — ladder chunk").catch(e => log(`  close error: ${e.message.slice(0, 80)}`));
          continue;
        }
        if (lp && isSpiking(m)) {
          if (await spikeManage(addr, m, lp.pnl) === "closed") continue;
        }
        if (CFG.TSL_ACTIVATE_PCT > 0 && pnl != null && (m.peakPnl ?? 0) >= CFG.TSL_ACTIVATE_PCT
            && +pnl <= +m.peakPnl - CFG.TSL_DISTANCE_PCT) {
          await closeMine(addr, m, `trailing stop: peak +${(+m.peakPnl).toFixed(1)}% -> ${(+pnl).toFixed(1)}%`); continue;
        }
        // OOR below: fully filled bag earning nothing
        if (CFG.AUTO_CLOSE_OOR_MIN >= 0 && below && !mirrorHold(m)) {
          if (CFG.AUTO_CLOSE_OOR_MIN === 0) { await closeMine(addr, m, "fully filled below range — immediate exit"); continue; }
          m.oorSince = m.oorSince || Date.now(); save();
          const min = (Date.now() - m.oorSince) / 60_000;
          if (min >= CFG.AUTO_CLOSE_OOR_MIN) { await closeMine(addr, m, `fully filled + out of range ${min.toFixed(0)}min`); continue; }
        } else if (m.oorSince) { m.oorSince = null; save(); }
        // mirror-hold fill-through, evaluated ONCE at the transition: positive PnL when price
        // exits below the ladder -> close now and lock the win (fees are dead down here).
        // Negative fills ride for reversion until the source exits or the hard line.
        if (below && mirrorHold(m)) {
          if (!m.belowAt) {
            m.belowAt = Date.now(); save();
            const pv = (pnl != null && Number.isFinite(+pnl)) ? +pnl
                     : (Number.isFinite(+m.lastPnl) ? +m.lastPnl : null);
            if (CFG.HOLD_CLOSE_POS_PCT != null && pv != null && pv > CFG.HOLD_CLOSE_POS_PCT) {
              await closeMine(addr, m, `filled through while positive (+${pv.toFixed(1)}%) — locking the win`); continue;
            }
          }
        } else if (m.belowAt) { m.belowAt = null; save(); }
        if (below && mirrorHold(m) && !m.holdNoted) {
          m.holdNoted = true; save();
          log(`  [hold] ${addr.slice(0, 8)}… filled through but source still holds — riding for reversion (hard line is the cap)`);
        }
        // OOR above: armed by in-range history OR by price distance above the top
        let farAbove = false;
        if (above && !m.wasInRange && ap) {
          const step2 = m.step ?? ap.dl.lbPair.binStep;
          const binsUp = Math.round(Math.log(1 + CFG.OOR_UP_ARM_PCT / 100) / Math.log(1 + step2 / 10000));
          farAbove = (ap.activeId - m.maxBin) >= binsUp;
        }
        // effective OOR-up timer: per-target oorup= wins; else follow=source-held positions use
        // FOLLOW_OOR_UP_MIN (0 = keep holding, the old behavior); else the global AUTO_CLOSE_OOR_UP_MIN.
        const held = mirrorHold(m);
        const tOorUp = TCFG[m.target]?.oorUpMin;
        const oorUpMin = tOorUp != null ? tOorUp : held ? CFG.FOLLOW_OOR_UP_MIN : CFG.AUTO_CLOSE_OOR_UP_MIN;
        if (oorUpMin > 0 && above && (m.wasInRange || farAbove)) {
          m.oorUpSince = m.oorUpSince || Date.now(); save();
          const min = (Date.now() - m.oorUpSince) / 60_000;
          if (min >= oorUpMin)
            { await closeMine(addr, m, (m.wasInRange ? `price left range upward ${min.toFixed(0)}min ago` : `price ${CFG.OOR_UP_ARM_PCT}%+ above untouched ladder for ${min.toFixed(0)}min`) + (held ? " (pierced follow=source hold)" : "")); continue; }
        } else if (m.oorUpSince) { m.oorUpSince = null; save(); }
        // fee claims: pool aggregate spread over its positions as trigger heuristic
        if (CFG.FEE_CLAIM_HOURS > 0) {
          const pr = poolFeeRow[m.pool];
          const poolPosCount = Object.values(S.mine).filter(x => !x.closed && x.pool === m.pool).length || 1;
          const feeSol = pr ? (+pr.unclaimedFeesSol || 0) / poolPosCount : 0;
          const dueH = (Date.now() - (m.lastClaim || m.ts)) / 3.6e6;
          // pre-filter at half threshold (equal-split heuristic misallocates in shared pools);
          // claimFees verifies the exact per-position amount before claiming
          if (dueH >= CFG.FEE_CLAIM_HOURS && feeSol >= CFG.FEE_CLAIM_MIN_SOL * 0.5) {
            log(`  fee claim due ${addr.slice(0, 8)}…: ~${feeSol.toFixed(3)} SOL unclaimed after ${dueH.toFixed(1)}h`);
            await claimFees(addr, m);
          }
        }
      }
    }
  }
  // 3) hand the fast guard its watch list, then sweep crumbs
  dangerPools = nextDanger; // 10s polling fallback keeps the danger scope (WS-outage degradation path)
  watchPools = new Set(Object.values(S.mine).filter(m => !m.closed && m.pool).map(m => m.pool));
  syncPoolSubs(); // real-time WS watch covers EVERY open pool — no 30s blind window on knives
  if (CFG.JANITOR_MIN > 0) await walletJanitor().catch(e => log("  janitor error:", e.message.slice(0, 60)));
}


// ------------------------------------------------------------ CLI closes ---
// STOP THE RUNNING BOT FIRST (Ctrl+C), then:
//   node copylp.js --close-all              close every open mirror
//   node copylp.js --close-target=<wallet>  close all mirrors of one source wallet
//   node copylp.js --close-mint=<mint>      close all mirrors on one token
//   node copylp.js --close-pos=<addr>       close one position (address or unique prefix; orphans/husks included)
async function runCliCloses() {
  if (process.argv.includes("--version")) { console.log(`copylp v${BOT_VERSION}`); process.exit(0); }
  if (process.argv.includes("--ledger-report")) {
    const W = wlState();
    console.log(`copylp v${BOT_VERSION} wallet-truth ledger`);
    console.log(ledgerTotalsLine() || "no closed holdings measured yet");
    const gl = ledgerGateLine(); if (gl) console.log(gl);
    console.log("\nby target (wallet SOL, % of deployed, tracker):");
    for (const [k, b] of Object.entries(W.byTarget).sort((a, b) => a[1].walletSol - b[1].walletSol))
      console.log(`  ${k}  ${String(b.n).padStart(4)} holdings  ${String(b.wins).padStart(4)} wins  wallet ${fmtS(b.walletSol).padStart(9)}${pctOf(b.walletSol, b.depositSol).padEnd(11)}  on ${b.depositSol.toFixed(0).padStart(6)} SOL  tracker ${fmtS(b.trackerSol)}`);
    const recent = Object.values(W.eps).filter(e => e.done && !e.partial).sort((a, b) => b.end - a.end).slice(0, 15);
    console.log("\nlast closes:");
    for (const e of recent) console.log(`  ${new Date(e.end).toISOString().slice(5, 16)} [${(e.target || "?").slice(0, 6)}] ${e.sym}  wallet ${fmtS(e.walletLamports / 1e9)}  tracker ${fmtS(e.trackerSol)}  dep ${e.depositSol.toFixed(2)}`);
    process.exit(0);
  }
  if (process.argv.includes("--scr-report")) {
    // bot-ledger ESTIMATE (deposit x last pnl reading; trims included). On-chain truth needs the Helius analysis.
    const rows = {};
    for (const m of Object.values(S.mine)) {
      if (!m.scrTag) continue;
      const t = m.scrTag, k = t.state === "listed" ? t.tier : t.state;
      const r = (rows[k] = rows[k] || { n: 0, sol: 0, closed: 0, wins: 0, pnl: 0, would: 0 });
      r.n++; r.sol += m.solIn || 0; if (t.wouldBlock) r.would++;
      if (m.closed && Number.isFinite(+m.lastPnl)) { r.closed++; if (+m.lastPnl > 0) r.wins++; r.pnl += (m.solIn || 0) * (+m.lastPnl) / 100 + (m.trimPnlSol || 0); }
    }
    const keys = Object.keys(rows).sort((a, b) => rows[b].n - rows[a].n);
    console.log(`copylp v${BOT_VERSION} — mirrors by screener tag at open (estimate: deposit x last pnl reading)`);
    console.log("tag".padEnd(18) + "opens".padStart(6) + "  SOL in".padStart(9) + " closed".padStart(8) + "  win%".padStart(6) + "  est pnl".padStart(10) + "  ret/SOL".padStart(9) + "  would-block".padStart(13));
    for (const k of keys) { const r = rows[k];
      console.log(k.padEnd(18) + String(r.n).padStart(6) + r.sol.toFixed(1).padStart(9) + String(r.closed).padStart(8) + (r.closed ? (100 * r.wins / r.closed).toFixed(0) : "-").padStart(6) + r.pnl.toFixed(2).padStart(10) + (r.sol ? (100 * r.pnl / r.sol).toFixed(2) + "%" : "-").padStart(9) + String(r.would).padStart(13)); }
    if (!keys.length) console.log("no tagged mirrors yet — turn on SCREENER_GATE=shadow and let it run");
    process.exit(0);
  }
  const arg = process.argv.find(a => a.startsWith("--close"));
  if (!arg) return false;
  const [flag, val] = arg.split("=");
  const open = Object.entries(S.mine).filter(([, m]) => !m.closed);
  let hits = [];
  if (flag === "--close-all") hits = open;
  else if (flag === "--close-target") hits = open.filter(([, m]) => m.target === val);
  else if (flag === "--close-mint") hits = open.filter(([, m]) => m.mint === val);
  else if (flag === "--close-pos") {
    hits = open.filter(([a]) => a === val || a.startsWith(val));
    if (hits.length > 1) { console.error(`prefix '${val}' matches ${hits.length} open positions — be more specific`); process.exit(1); }
  }
  else { console.error("unknown close flag"); process.exit(1); }
  log(`CLI: closing ${hits.length} position(s) [${flag.replace("--", "")}${val ? " " + val.slice(0, 8) : ""}]`);
  if (!hits.length) process.exit(0);
  for (const [addr, m] of hits) {
    await closeMine(addr, m, `manual CLI ${flag.replace("--", "")}`);
    if (!m.closed) log(`  NOTE ${addr.slice(0, 8)}… did not confirm closed — rerun the command`);
  }
  log(`CLI done. ${Object.values(S.mine).filter(m => !m.closed).length} position(s) still open in ledger.`);
  process.exit(0);
}

(async () => {
  await runCliCloses();
  if (Object.keys(CFG.GROUP_BUDGETS).length) log(`group budgets: ${Object.entries(CFG.GROUP_BUDGETS).map(([n, p]) => `${n}=${p} SOL${CFG.GROUP_CAP_ONLY.has(n) ? " (cap-only)" : CFG.GROUP_RES_ONLY.has(n) ? " (reserve-only, no ceiling)" : ""}`).join(" ")} | members: ${TARGET_CFG.filter(t => t.group).map(t => `${t.addr.slice(0, 6)}:${t.group}`).join(" ") || "none"}`);
  log(`copylp v${BOT_VERSION} up | ${TARGETS.length} target(s): ${TARGET_CFG.map(t => t.addr.slice(0, 6)
    + (t.fixedSol ? ":fixed=" + t.fixedSol : t.maxSol ? ":max=" + t.maxSol : "")
    + (t.pct != null ? ":pct=" + t.pct : "")
    + (t.lowMcapSol != null ? ":lowmcap=" + t.lowMcapSol : "")
    + (t.minDep != null ? ":min=" + t.minDep : "")).join(", ")}`);
  log(`mode=${CFG.COPY_MODE} (${CFG.COPY_MODE === "ratio" ? CFG.COPY_RATIO_PCT + "%" : CFG.COPY_FIXED_SOL + " SOL"}, cap ${CFG.MAX_COPY_SOL} SOL) | ` +
      `min their deposit ${CFG.MIN_TARGET_DEPOSIT_SOL} SOL | caps ${CFG.MAX_POS_PER_WALLET}/wallet ${CFG.MAX_GLOBAL_POSITIONS} global`);
  log(`gates: jup>=${CFG.MIN_JUP_SCORE} mcap>=$${CFG.MIN_MCAP_USD / 1e6}M age>=${CFG.MIN_TOKEN_AGE_H}h width>=${CFG.MIN_WIDTH_PCT}%/${CFG.MIN_WIDTH_LOWCAP_PCT}%(<$${CFG.MIN_WIDTH_MCAP_USD / 1e6}M) | ` +
      `exits: mirror close / SL -${CFG.STOP_LOSS_PCT}% (per-target sl=/hot=/hard=/follow= overrides apply) / OOR ${CFG.AUTO_CLOSE_OOR_MIN}min / OOR-up ${CFG.AUTO_CLOSE_OOR_UP_MIN}min (follow-pierce ${CFG.FOLLOW_OOR_UP_MIN || "off"}${CFG.FOLLOW_OOR_UP_MIN ? "min" : ""}, per-target oorup= overrides) | DRY_RUN=${CFG.DRY_RUN}`);
  { const gateOn = CFG.SCREENER_GATE !== "off" || TARGET_CFG.some(t => t.scrGate && t.scrGate !== "off");
    if (gateOn && SCR_REMOTE) await fetchRemotePicks();             // first copy before any open can ask for it
    const P = gateOn ? screenerPicks() : null;
    const per = TARGET_CFG.filter(t => t.scrGate).map(t => `${t.addr.slice(0, 6)}=${t.scrGate}`);
    log(`screener gate: ${CFG.SCREENER_GATE}${per.length ? ` (per-wallet: ${per.join(" ")})` : ""}` +
        (P ? ` | picks ${((Date.now() / 1000 - (P.ts || 0)) / 60).toFixed(0)}m old, ${Object.keys(P.pools || {}).length} pools` : CFG.SCREENER_GATE_FILE ? ` | picks unreadable: ${_scrCache.err}` : (CFG.SCREENER_GATE !== "off" ? " | SCREENER_GATE_FILE not set — gate inactive" : ""))
        + (CFG.SCREENER_GATE_MAX_PACE > 0 ? ` | pace ceiling ${CFG.SCREENER_GATE_MAX_PACE}%/day` : "")); }
  if (signer) await repairChunkGroups().catch(e => log(`chunk repair error: ${(e.message || "").slice(0, 80)}`));
  log(`fee-spike de-risk: ${CFG.SPIKE_FEE_30M_PCT > 0 ? `ON at ${CFG.SPIKE_FEE_30M_PCT}%/30m — claim + block pool; trim ${CFG.SPIKE_TRIM_PCT}% at pnl <= ${CFG.SPIKE_TRIM_PNL}%; exit at pnl <= ${CFG.SPIKE_EXIT_PNL}%; re-check every ${CFG.SPIKE_CHECK_MIN}m` : "off (SPIKE_FEE_30M_PCT=0)"}`);
  log(`hard-SL cooldown: ${CFG.HARD_SL_COOLDOWN_MIN > 0 ? CFG.HARD_SL_COOLDOWN_MIN + "min no-new-opens per token after a hard-line stop" : "off"}${Object.keys(S.slCooldown).length ? ` | active: ${Object.entries(S.slCooldown).map(([k, v]) => `${k.slice(0, 6)}(${Math.ceil((v.until - Date.now()) / 60000)}m)`).join(" ")}` : ""}`);
  if (signer) log("signer:", signer.publicKey.toBase58());
  log(`wallet-truth ledger: on${ledgerTotalsLine() ? " | " + ledgerTotalsLine() : " | no closed holdings measured yet"}`);
  { const gl = ledgerGateLine(); if (gl) log(gl); }
  log(`pump gate: ${CFG.MAX_PUMP_1H_PCT > 0 || CFG.MAX_PUMP_6H_PCT > 0 ? `skip tokens up > ${CFG.MAX_PUMP_1H_PCT || "-"}% in 1h / > ${CFG.MAX_PUMP_6H_PCT || "-"}% in 6h` : "off"}`);
  setInterval(() => ledgerWorker().catch(() => {}), 20_000);
  connectWs();
  if (CFG.FAST_POLL_SECONDS > 0) {
    log(`fast-guard armed: ${CFG.FAST_POLL_SECONDS}s watch on danger pools, stop = fee-inclusive pnl <= -${CFG.STOP_LOSS_PCT}% only`);
    setInterval(() => fastGuard().catch(e => log("fast-guard error:", e.message.slice(0, 80))), CFG.FAST_POLL_SECONDS * 1000);
  }
  while (true) {
    await tick().catch(e => log("tick error:", e.message));
    await new Promise(r => setTimeout(r, CFG.POLL_SECONDS * 1000));
  }
})();
