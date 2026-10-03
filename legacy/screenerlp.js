#!/usr/bin/env node
/**
 * copylp — mirrors DLMM LP wallets (not swap traders).
 *
 * VERSION HISTORY (bump BOT_VERSION below on every build; prints on boot and via `node copylp.js --version`)
 * 0.7.18 HOT MIN TOKEN AGE. SCREENER_HOT_MIN_AGE_H (0 = off): a HOT open, or an upgrade into HOT, is skipped
 *        when the token's first pool is younger than this (Jupiter token data; unknown age = skipped).
 *        CORE/WATCH and re-centers of legs already held are not affected.
 * 0.7.17 PER-TIER LADDER DEPTH. SCREENER_DEPTH_CORE / SCREENER_DEPTH_HOT / SCREENER_DEPTH_WATCH set the
 *        base-leg depth (%) by the pick's tier (CORE+ uses the CORE value), on every bin step, for
 *        opens, upgrades and re-centers. Applies to BidAsk base legs and to Spot base legs (BASE_SHAPE=spot).
 *        Unset/0 = old behaviour (SCREENER_DEPTH / SCREENER_DEPTH_HISTEP / SCREENER_BASE_SPOT_DEPTH).
 *        The CORE+ Spot leg (PLUS_SHAPE=spot) keeps SCREENER_PLUS_SPOT_DEPTH. Existing ladders are not
 *        touched; new depth applies from their next re-center or add.
 *        PER-TIER SHAPE: SCREENER_SHAPE_CORE / _HOT / _WATCH = bidask | spot override SCREENER_BASE_SHAPE for
 *        that tier's base legs (e.g. screenerlp2 runs Spot but HOT as BidAsk). Unset = BASE_SHAPE.
 *        Spot-mode fix: with a tier depth set, Spot upgrade/re-center legs use the tier depth instead of
 *        SCREENER_PLUS_SPOT_DEPTH (that one is only for the CORE+ Spot leg of a BidAsk instance).
 * 0.7.16 CORE SLOT FIX + "why no open" log. Since v0.7.12 a CORE is sized to CORE_TVL_PCT of pool TVL
 *        (up to CORE_MAX_SOL), but CORE slots were still counted as size / SCREENER_CORE_SOL — so a 1X
 *        CORE of 35 SOL in a big pool used 2 of SCREENER_MAX_CORE, and a few TVL-scaled pools filled
 *        every slot. New CORE picks were then skipped SILENTLY. Slots now count against the pool's own
 *        1X size (the TVL-scaled one): 1X = 1 slot, CORE+ = PLUS_MULT slots, as intended. And when a pick
 *        qualifies but a cap blocks it (CORE/HOT/WATCH slots full, per-token cap, 1h retry wait), the bot
 *        logs one "[SCRN] waiting:" line naming the pools and the cap (only when that list changes).
 *        Boot log now lists IGNORED_MINTS, so you can confirm the blocklist the running process loaded.
 *        Aged tokens: the screener now marks tokens 7d+ old ("aged") and lets them in at a lower pace;
 *        clean-WATCH opens for those use SCREENER_WATCH_MIN_PACE_AGED (2) instead of SCREENER_WATCH_MIN_PACE.
 *        Low-pace sizing: an aged pool the screener lets in only thanks to the lower line (lowPace) opens
 *        at SCREENER_LOWPACE_MULT (0.5) of CORE size, and a held aged pool that slows into that band is cut
 *        once to the same 50% instead of exiting; back above the normal line = the upgrade pass refills it.
 *        Re-center respects IGNORED_MINTS (an out-of-range leg of a blocklisted mint is closed, not
 *        reopened), and a leg you closed by hand is no longer "re-centered" back open (tOpenAI
 *        2026-09-30: closed manually 17:58 BKK, bot reopened it at 18:59 as a re-center).
 * 0.7.15 LEDGER FIXES. (1) A tx that LANDS after the send call timed out was never recorded (SI on
 *        screenerlp2 2026-09-29: a 3.24 SOL withdrawal landed at 16:10 unrecorded -> ledger said -3.1 SOL,
 *        chain says +0.12). The signature is now recorded when the send call throws too (taken from the
 *        error or the signed tx); the worker reads it back and counts it only if it's on chain; txs that
 *        never land resolve as 0 after ~13 min instead of blocking the holding forever. (2) Holdings that
 *        were trimmed show "tracker n/a" — the position UI's % after a trim is vs the original deposit —
 *        and are left out of the tracker-vs-wallet gap. (3) Totals restart clean on first boot (pre-fix
 *        totals were polluted by missed txs; kept in S.wl.v1Totals); in-flight holdings count as partial.
 * 0.7.14 SCREENER_MIN_BIN_STEP (default 0 = off): pools with a smaller bin step are never opened, added
 *        to or re-centered by the screener bots (step-20 pools need hundreds of bins / many position
 *        accounts for a normal-depth ladder). Held positions in such pools are left to the normal exits;
 *        a re-center on one just closes the leg.
 * 0.7.13 bin-array guard fails CLOSED: if the bot can't verify which bin arrays exist (PDA derivation
 *        mismatch / RPC error), the open is SKIPPED instead of going ahead unchecked — so no screener
 *        open, add, 2nd pool or re-center can create a non-refundable bin array. Every guard verdict is
 *        logged ("bin arrays: all N exist" / "cut" / "skip").
 * 0.7.12 CORE sizes up with pool TVL. With SCREENER_CORE_TVL_PCT > 0, a CORE pool's size is
 *        max(SCREENER_CORE_SOL, that % of the pool's live TVL), capped at SCREENER_CORE_MAX_SOL; CORE+
 *        multiplies that by PLUS_MULT. Held CORE pools grow toward the new size through the normal
 *        upgrade pass (same add-gate). SCREENER_MAX_TVL_PCT is a hard ceiling for EVERY open/add on
 *        every tier (a fixed 15 SOL can no longer be 7% of a $27k pool). TVL + SOL price come from the
 *        Meteora data API (cached 10 min); if unavailable, the fixed tier sizes are used.
 * 0.7.11 live market-cap check on ENTRY (new opens + 2nd pools): right before opening, the pool's
 *        current token mcap is read from the Meteora data API and the open is skipped if it is below
 *        SCREENER_MIN_MCAP_USD (default 1,000,000; 0 = off). The screener's picks can be up to an hour
 *        stale (YAP 2026-09-29 reopened at ~$308k). Upgrades and re-centers are not affected. If the
 *        data API is down, the open goes ahead on the screener's own check (logged).
 * 0.7.10 LADDER CHUNK FIX + BIN-ARRAY GUARD + LEDGER FIX.
 *        (a) A ladder too wide for one position is split into chunk positions. Each chunk used to be
 *            booked at an EQUAL share of the deposit and with the WHOLE ladder's bin range. Spot/BidAsk
 *            put very different SOL into each chunk, so chunks showed fake +/-PnL from the first second
 *            (PAID 2026-09-29: two chunks at +27.5% / -27.5%; the "-27.5%" one hit the hard stop 5 min
 *            after opening) and a chunk left below price was never re-centered (the whole-ladder top
 *            still looked in range). Now: each chunk's real deposit and real bins are read from chain
 *            right after opening (cMin/cMax, ladderId); stops use the WHOLE ladder's pnl and close every
 *            chunk together; "above range" uses the top of the chunks still open; re-center closes the
 *            whole ladder and reopens it ONCE at the combined size. Open chunk groups from older builds
 *            are repaired on boot (real bins; basis re-split by value, or = SOL held for untouched chunks).
 *        (b) Bin-array guard (SCREENER_MAX_NEW_BIN_ARRAYS, default 0): before any screener open the bot
 *            checks which 70-bin arrays the ladder needs. Missing ones would cost ~0.0714 SOL each, kept
 *            by the pool forever — the ladder is cut back to the deepest already-existing array instead;
 *            if that leaves less than SCREENER_MIN_DEPTH_PCT (20%) the open is skipped.
 *        (c) Ledger: "new bin arrays" counted every InitializeBinArray log line, but the program runs that
 *            instruction as a no-op when the array already exists (checked on-chain: no rent was paid).
 *            Now counts only accounts actually created at bin-array rent size.
 * 0.7.9  SCREENER_BASE_SHAPE=spot (screenerlp2 default): every open that would have been the BidAsk
 *        60% ladder (CORE / HOT / WATCH base legs, their upgrades and re-centers) is a SPOT position
 *        SCREENER_BASE_SPOT_DEPTH (80%) deep instead — run beside screenerlp (BidAsk) on its own wallet
 *        as a shape A/B on the wallet-truth ledger. Everything else is identical to 0.7.8 (incl. the
 *        fee-spike de-risk). BOT_NAME env overrides the log name.
 * 0.7.8  fee-spike de-risk (SPIKE_FEE_30M_PCT, default 0 = off). A position earning >= that % of its
 *        deposit per 30min is SPIKING — in the Sep 15-29 on-chain data that was usually a sell-off
 *        trading down through the ladder (338 positions: 123 ended below -5% for -222 SOL). Staged:
 *        (1) spike -> claim fees now + block new opens, upgrades/top-ups, re-center reopens and mirror
 *        adds on that pool while it stays hot; (2) spike + pnl <= SPIKE_TRIM_PNL (0%) -> trim
 *        SPIKE_TRIM_PCT (50%) of that position once, via the normal screener trim (ledger + sell);
 *        (3) spike + pnl <= SPIKE_EXIT_PNL (-3%) -> close it. Fee rate is re-measured every
 *        SPIKE_CHECK_MIN on every open position while on. A spike-trimmed screener holding is not
 *        topped back up for SPIKE_REFILL_H hours.
 * 0.7.7  per-LEG re-center. The re-center timer used the pool's HIGHEST ladder top across all legs, so
 *        one leg still in range (an older, higher ladder) kept a newer leg sitting out of range above
 *        price forever (COLLECT 2026-09-29: 7 SOL leg out of range 3h+ while the 3 SOL leg was in).
 *        Now each leg has its own timer: a leg whose whole ladder is below price for SCREENER_RECENTER_H
 *        is closed ALONE and reopened at the new price with the same size and shape (if the pool is
 *        still CORE/HOT/clean WATCH); in-range legs are left untouched.
 * 0.7.6  WALLET-TRUTH LEDGER. Every transaction the bot lands (opens, adds, claims, trims, closes, Jupiter
 *        sells, WSOL unwraps, janitor sweeps) is attributed to a pool "holding" and read back from the
 *        chain: signer SOL change + WSOL change per tx = what the wallet actually gained or lost,
 *        including tx fees, non-refundable bin-array rent, and exit-sell price impact. When a holding
 *        fully closes: tracker PnL vs wallet PnL and the gap, plus running totals. Opens that create
 *        new bin arrays are logged with their non-refundable rent. Measurement only — no trading change.
 * 0.7.5  trimmed pools can be added to again: a pool trimmed on the way toward EXIT that climbs back to
 *        HOT / CORE / CORE+ is upgraded like any other held pool (same add-gate). A successful add
 *        re-arms the graceful trim, so it can trim again if it slows a second time.
 * 0.7.4  WATCH entries + tier upgrades + 2nd pool per token. A clean WATCH pool (no slow/fading count,
 *        pace4h >= SCREENER_WATCH_MIN_PACE) held SCREENER_MIN_STREAK passes opens at SCREENER_WATCH_MULT
 *        (0.33) x CORE size. Held pools grow with their tier: WATCH -> HOT (HOT size), -> CORE (1X), ->
 *        CORE+ (PLUS_MULT, extra as Spot leg in spot mode); never shrink except trim/exit. Every add passes
 *        the v0.7.3 gate (mom >= SCREENER_PLUS_MIN_MOM, pace4h >= pace at open). A token may hold up to
 *        SCREENER_MAX_POOLS_PER_MINT (2) pools, the 2nd only while the token is listed in 2+ pools
 *        (CORE/HOT/clean WATCH); optional SCREENER_MAX_SOL_PER_MINT cap (0 = off). Clean-WATCH pools
 *        also re-center. Fresh CORE+ in spot mode opens 1X BidAsk; the upgrade pass adds the Spot leg.
 * 0.7.3  CORE+ Spot leg: with SCREENER_PLUS_SHAPE=spot the CORE+ extra size ((PLUS_MULT-1) x CORE) is
 *        added as a SPOT position from just below price down SCREENER_PLUS_SPOT_DEPTH (80%) instead of
 *        more BidAsk. Fresh CORE+ pools open 1X BidAsk first, then the Spot leg. Every top-up (Spot or
 *        BidAsk) now needs pace4h >= the pool's pace4h at our first open AND mom >= SCREENER_PLUS_MIN_MOM
 *        (1.0) — no more doubling into a slowing pool (PAID 2026-09-28). Trims come out of the Spot leg
 *        first. Per-shape ledger (SCREENER:BidAsk / SCREENER:Spot) with net PnL per SOL-day.
 * 0.7.2  screener sizing + trim: CORE+ pools (screener's most-stable flag) open at SCREENER_PLUS_MULT x
 *        CORE size (default 2) and pools already held get TOPPED UP to that size (SCREENER_PLUS_TOPUP).
 *        A CORE+ pool uses PLUS_MULT slots of SCREENER_MAX_CORE. Graceful exit: when a held pool is in
 *        WATCH and counting toward EXIT (slow/fading) with pace4h < SCREENER_TRIM_KEEP_PACE (3%), trim
 *        SCREENER_TRIM_PCT (25%) once per holding; pace still >= 3% = unchanged; EXIT = close 100%.
 *        A trimmed pool is never topped back up while held.
 * 0.7.1  screener re-center: SCREENER_RECENTER_H (e.g. 3) — when price has been ABOVE a screener
 *        ladder that long, close it; if the pool is still CORE/HOT it reopens at the new price on the
 *        same pass (cooldown skipped), otherwise it just frees the capital. Checked every 5 min.
 * 0.7.0  SCREENER MODE (SCREENER_PICKS=path to screener_picks.json): opens BidAsk ladders (60% deep,
 *        70% at step>=125) in pools the screener rates CORE (3 SOL) / HOT (1.5 SOL) on 2+ consecutive
 *        passes; max 4 CORE + 2 HOT; keeps a 5 SOL reserve; skips taxed coins; closes on screener
 *        EXIT (too slow / fading / LPs leaving / gone 2 passes) or the -18% hard stop. Reuses the
 *        proven v0.6.x send + close paths unchanged. TARGET_WALLETS may be empty in this mode.
 * 0.6.15 shape rule (SHAPE_RULE, default on): a mirrored Spot/Curve open is forced to BidAsk when the
 *        pool's fee pace >= SHAPE_RULE_PACE (15%/day, SHAPE_RULE_WINDOW 4h) or bin step >= SHAPE_RULE_STEP
 *        (100). Opens only; adds keep their own shape. Per-target opt-out shaperule=off.
 * 0.6.14 small-cap size cap (SMALLCAP_MCAP_USD/SMALLCAP_MAX_SOL, per-target smallcap=/smallmax=;
 *        unknown mcap counts as small) + taxed-coin fee floor (TAXFEE_MIN_PCT at tax >=
 *        TAXFEE_MIN_TAX_BPS, over TAXFEE_WINDOW 30m..24h extrapolated to a daily pace; per-target
 *        taxfee=/taxwin=; missing fee data fails closed).
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
const { AsyncLocalStorage } = require("async_hooks");

// ===== v0.7.6 wallet-truth ledger ======================================================================
// Every landed tx is tagged with the pool "holding" it belongs to (AsyncLocalStorage context set by the
// open / add / claim / trim / close / janitor wrappers) and read back from chain later.
const LEDGER_CTX = new AsyncLocalStorage();
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BINARRAY_RENT_SOL = 0.0714;            // rent-exempt minimum of one 70-bin DLMM bin array (~10.1 kB)
function wlState() {
  S.wl = S.wl || {};
  S.wl.eps = S.wl.eps || {}; S.wl.active = S.wl.active || {}; S.wl.pending = S.wl.pending || [];
  S.wl.misc = S.wl.misc || 0;
  if (S.wl.ver !== 2) {                        // v0.7.15: pre-fix totals were polluted by missed txs
    if (S.wl.totals) S.wl.v1Totals = S.wl.totals;
    S.wl.totals = null; S.wl.ver = 2;
    for (const e of Object.values(S.wl.eps || {})) if (!e.done) e.partial = true;   // in-flight holdings may miss pre-fix txs
  }
  S.wl.totals = S.wl.totals || { holdings: 0, trackerSol: 0, walletSol: 0, feeSol: 0, binArrays: 0, depositSol: 0, gapHoldings: 0, gapTracker: 0, gapWallet: 0 };
  return S.wl;
}
function wlEpisodeFor(ctx, create) {
  const W = wlState();
  if (ctx.pool) {
    let id = W.active[ctx.pool];
    if (!id && create) {
      id = ctx.pool + ":" + Date.now();
      W.eps[id] = { pool: ctx.pool, mint: ctx.mint || null, sym: ctx.sym || ctx.pool.slice(0, 6), start: Date.now(), end: null,
        partial: !ctx.open, sigs: 0, resolved: 0, walletLamports: 0, feeLamports: 0, binArrays: 0, trackerSol: 0, depositSol: 0, done: false };
      W.active[ctx.pool] = id;
    }
    return id || null;
  }
  if (ctx.mint) {                            // janitor sweep: attribute to the latest holding of that token
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
    const ctx = LEDGER_CTX.getStore() || {};
    const id = wlEpisodeFor(ctx, true);
    W.pending.push({ sig, id: id || "misc", t: Date.now(), tries: 0, unconfirmed });
    if (id && W.eps[id]) W.eps[id].sigs++;
  } catch {}
}
// v0.7.15: record the signature even when the send/confirm call throws (a timeout does NOT mean the
// tx didn't land). The worker verifies on chain and only counts what actually landed.
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
function ledgerTrackerAdd(m, pnlSol) {       // tracker (position-UI) PnL booked by closes/trims, for the gap
  try {
    const W = wlState(); const id = W.active[m.pool];
    if (id && W.eps[id] && Number.isFinite(pnlSol)) W.eps[id].trackerSol += pnlSol;
    if (id && W.eps[id] && m.scrTrimmed) W.eps[id].trackerNA = true;   // v0.7.15: UI % after a trim is vs the original deposit
  } catch {}
}
function ledgerEndIfFlat(pool) {
  const W = wlState(); const id = W.active[pool];
  if (!id) return;
  const liveLeft = Object.values(S.mine).some(m => !m.closed && m.pool === pool);
  if (!liveLeft) { W.eps[id].end = Date.now(); delete W.active[pool]; save(); }
}
const fmtS = v => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
function ledgerTotalsLine() {
  const T = wlState().totals;
  if (!T.holdings) return "";
  const gap = (T.gapWallet || 0) - (T.gapTracker || 0);          // v0.7.15: gap over untrimmed holdings only
  return `${T.holdings} closed holding(s): tracker ${fmtS(T.trackerSol)} SOL | wallet ${fmtS(T.walletSol)} SOL` +
    (T.depositSol > 0 ? ` (${(100 * T.walletSol / T.depositSol).toFixed(2)}% on ${T.depositSol.toFixed(1)} SOL deployed)` : "") +
    ` | gap ${fmtS(gap)} SOL (${T.gapHoldings || 0} untrimmed) | tx fees ${T.feeSol.toFixed(3)} | new bin arrays ${T.binArrays} (~${(T.binArrays * BINARRAY_RENT_SOL).toFixed(3)} SOL kept by chain)`;
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
        // never landed (or unreadable) after ~13 min: resolve as 0 so the holding can still finalize
        const e0 = it.id !== "misc" ? W.eps[it.id] : null; if (e0) e0.resolved++;
        if (!it.unconfirmed) log(`  [LEDGER] gave up reading ${it.sig.slice(0, 10)}… — counted as not landed`);
        continue;
      }
      if (it.unconfirmed) log(`  [LEDGER] tx ${it.sig.slice(0, 10)}… timed out at send but LANDED on chain — counted`);
      const meta = tx.meta;
      // our signer's index (usually 0 = fee payer; Jupiter Ultra gasless txs can have another payer)
      const msg = tx.transaction.message;
      const keys = (msg.staticAccountKeys || msg.accountKeys || []).map(k => (k.toBase58 ? k.toBase58() : String(k)));
      const idx = Math.max(0, keys.indexOf(me));
      const native = (meta.postBalances[idx] || 0) - (meta.preBalances[idx] || 0);
      const wsolOf = arr => (arr || []).filter(b => b.owner === me && b.mint === WSOL_MINT).reduce((a, b) => a + Number(b.uiTokenAmount.amount || 0), 0);
      const lam = native + (wsolOf(meta.postTokenBalances) - wsolOf(meta.preTokenBalances));
      // v0.7.10: the InitializeBinArray instruction is a no-op when the array already exists, so the
      // log line alone over-counts. Count only accounts actually CREATED in this tx at bin-array rent.
      const nLog = (meta.logMessages || []).filter(l => /Instruction: InitializeBinArray/.test(l)).length;
      const nNew = nLog ? (meta.preBalances || []).filter((pre, i) => pre === 0 && (meta.postBalances[i] || 0) >= 70_500_000 && (meta.postBalances[i] || 0) <= 73_000_000).length : 0;
      const nArr = Math.min(nLog, nNew);
      const e = it.id !== "misc" ? W.eps[it.id] : null;
      if (!e) { W.misc += lam; continue; }
      e.walletLamports += lam; e.feeLamports += idx === 0 ? (meta.fee || 0) : 0; e.binArrays += nArr; e.resolved++;
      if (nArr > 0) log(`  [LEDGER] ${e.sym}: tx created ${nArr} new bin array(s) — ~${(nArr * BINARRAY_RENT_SOL).toFixed(3)} SOL non-refundable`);
    }
    W.pending.unshift(...keep);
    // finalize holdings that are closed and fully read
    for (const [id, e] of Object.entries(W.eps)) {
      if (e.done || !e.end || e.resolved < e.sigs) continue;
      if (Date.now() - e.end < 90_000) continue;             // let the exit sell / unwrap land first
      e.done = true;
      const wal = e.walletLamports / 1e9, fee = e.feeLamports / 1e9, gap = wal - e.trackerSol, hrs = (e.end - e.start) / 3600e3;
      const pct = v => e.depositSol > 0 ? ` (${v >= 0 ? "+" : ""}${(100 * v / e.depositSol).toFixed(2)}%)` : "";
      log(`  [LEDGER] ${e.sym} holding closed after ${hrs.toFixed(1)}h${e.partial ? " [partial: opened before the v0.7.15 ledger fix — not in totals]" : ""}: ` +
          (e.trackerNA ? `tracker n/a (trimmed) | wallet ${fmtS(wal)} SOL${pct(wal)} | ` : `tracker ${fmtS(e.trackerSol)} SOL${pct(e.trackerSol)} | wallet ${fmtS(wal)} SOL${pct(wal)} | gap ${fmtS(gap)} SOL | `) +
          `tx fees ${fee.toFixed(4)} | new bin arrays ${e.binArrays} (~${(e.binArrays * BINARRAY_RENT_SOL).toFixed(3)} SOL)`);
      if (!e.partial) {
        const T = W.totals;
        T.holdings++; T.trackerSol += e.trackerSol; T.walletSol += wal; T.feeSol += fee; T.binArrays += e.binArrays; T.depositSol += e.depositSol;
        if (!e.trackerNA) { T.gapHoldings = (T.gapHoldings || 0) + 1; T.gapTracker = (T.gapTracker || 0) + e.trackerSol; T.gapWallet = (T.gapWallet || 0) + wal; }
        log(`  [LEDGER] totals — ${ledgerTotalsLine()}`);
      }
    }
    // prune: keep the newest 300 finished holdings
    const doneIds = Object.entries(W.eps).filter(([, e]) => e.done).sort((a, b) => b[1].end - a[1].end).map(([id]) => id);
    for (const id of doneIds.slice(300)) delete W.eps[id];
    save();
  } catch (e) { log("  [LEDGER] worker error:", (e.message || "").slice(0, 80)); }
  finally { _ledgerBusy = false; }
}
// =======================================================================================================
const DLMM = DLMMPkg.default ?? DLMMPkg;
const { StrategyType, decodeAccount, getPriceOfBinByBinId } = DLMMPkg;

const BOT_VERSION = "0.7.18";
// name shown in logs: "screenerlp" when running in screener mode with no copy targets, else "copylp"
const BOT_NAME = process.env.BOT_NAME || ((process.env.SCREENER_PICKS && !(process.env.TARGET_WALLETS || "").trim()) ? "screenerlp" : "copylp");
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
  // v0.6.14 small-cap size cap: coins under SMALLCAP_MCAP_USD open at most SMALLCAP_MAX_SOL (0 = rule off).
  // Unknown mcap (too new for data) counts as small — fail safe.
  SMALLCAP_MCAP_USD  : parseFloat(env("SMALLCAP_MCAP_USD", "0")),
  SMALLCAP_MAX_SOL   : parseFloat(env("SMALLCAP_MAX_SOL", "3")),
  // v0.6.14 tax-pool fee floor: tokens taxed >= TAXFEE_MIN_TAX_BPS need pool fee/TVL >= TAXFEE_MIN_PCT
  // (per-day pace) measured over TAXFEE_WINDOW (30m|1h|2h|4h|12h|24h — short windows are extrapolated
  // to a 24h pace, so a pool whose volume died hours ago can't coast on its trailing 24h number).
  TAXFEE_MIN_PCT     : parseFloat(env("TAXFEE_MIN_PCT", "0")),         // 0 = rule off
  TAXFEE_MIN_TAX_BPS : parseFloat(env("TAXFEE_MIN_TAX_BPS", "300")),   // applies at tax >= 3% by default
  TAXFEE_WINDOW      : env("TAXFEE_WINDOW", "24h"),
  AUTOPAUSE_AFTER    : parseInt(env("AUTOPAUSE_AFTER", "0"), 10),      // 0 = manual pausing only (market-wide drawdowns redden every wallet; skill judgment stays human)
  PAUSED_TARGETS     : env("PAUSED_TARGETS", "").split(",").map(s => s.trim()).filter(Boolean), // manual pause list
  IGNORED_MINTS      : env("IGNORED_MINTS", "").split(",").map(s => s.trim()).filter(Boolean),

  STOP_LOSS_PCT      : parseFloat(env("STOP_LOSS_PCT", "8")),    // close ours at this fee-inclusive PnL breach
  SL_CONFIRM_SECONDS : parseFloat(env("SL_CONFIRM_SECONDS", "10")), // IN-RANGE breaches must persist this long before closing (wick filter; 0 = off)
  IN_RANGE_HARD_SL_PCT : parseFloat(env("IN_RANGE_HARD_SL_PCT", "13")), // hard collapse line: close immediately, no confirmation, no patience
  HOT_FEE_30M_PCT    : parseFloat(env("HOT_FEE_30M_PCT", "0.15")),
  // ---- fee-spike de-risk (0.7.8). SPIKE_FEE_30M_PCT=0 turns the whole feature off.
  SPIKE_FEE_30M_PCT  : parseFloat(env("SPIKE_FEE_30M_PCT", "0")),     // spiking when earning >= this % of deposit per 30min (0.8 ~ 38%/day)
  SPIKE_TRIM_PNL     : parseFloat(env("SPIKE_TRIM_PNL", "0")),        // stage 2: while spiking and pnl <= this %, trim once
  SPIKE_TRIM_PCT     : parseFloat(env("SPIKE_TRIM_PCT", "50")),       // share of the position withdrawn + sold on the trim (0 = no trim stage)
  SPIKE_TRIM_MIN_SOL : parseFloat(env("SPIKE_TRIM_MIN_SOL", "0.5")),  // don't trim positions smaller than this (claim/exit still apply)
  SPIKE_EXIT_PNL     : parseFloat(env("SPIKE_EXIT_PNL", "-3")),       // stage 3: while spiking and pnl <= this %, close the position
  SPIKE_CLAIM_MIN_SOL: parseFloat(env("SPIKE_CLAIM_MIN_SOL", "0.05")),// stage 1: claim on spike when unclaimed >= this (normal claims use FEE_CLAIM_MIN_SOL)
  SPIKE_CHECK_MIN    : parseFloat(env("SPIKE_CHECK_MIN", "5")),       // re-measure fee rate on every open position at least this often
  SPIKE_BLOCK_MIN    : parseFloat(env("SPIKE_BLOCK_MIN", "30")),      // pool stays blocked for opens/adds this long after its last spiking reading
  SPIKE_MIN_WINDOW_MIN: parseFloat(env("SPIKE_MIN_WINDOW_MIN", "5")), // ignore fee-rate readings measured over a shorter window (1-min reads extrapolate noise x30)
  SPIKE_REFILL_H     : parseFloat(env("SPIKE_REFILL_H", "6")),        // screener: no top-up of a spike-trimmed holding for this many hours  // position counts as HOT when earning >= this % of deposit per 30min (0 = hot logic off)
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
  MAX_MINT_SOL       : parseFloat(env("MAX_MINT_SOL", "120")),   // total SOL across all open positions in ONE token; new opens downsize into remaining headroom or skip (0 = off)

  ADDS_MIN_SRC_SOL   : parseFloat(env("ADDS_MIN_SRC_SOL", "1")), // adds=on targets: min source deposit growth (SOL value) that triggers a mirrored add
  SHAPE_MIRROR       : env("SHAPE_MIRROR", "true") !== "false", // mirror the source's liquidity shape (Spot/BidAsk/Curve) instead of always BidAsk
  // v0.6.15 shape rule: when mirroring would open Spot/Curve, force BidAsk instead if the pool is
  // hot (fee pace >= SHAPE_RULE_PACE %/day over SHAPE_RULE_WINDOW) or volatile (bin step >= SHAPE_RULE_STEP).
  // Opens only — mirrored ADDS keep their own shape. Per-target opt-out: shaperule=off
  SHAPE_RULE         : env("SHAPE_RULE", "on") !== "off",
  SHAPE_RULE_PACE    : parseFloat(env("SHAPE_RULE_PACE", "15")),
  SHAPE_RULE_WINDOW  : env("SHAPE_RULE_WINDOW", "4h"),
  SHAPE_RULE_STEP    : parseFloat(env("SHAPE_RULE_STEP", "100")),
  // v0.7.0 SCREENER MODE: open/close from screener.js picks instead of (or alongside) source wallets.
  // Enabled by setting SCREENER_PICKS to the screener's screener_picks.json path.
  SCREENER_PICKS        : env("SCREENER_PICKS", ""),
  SCREENER_CORE_SOL     : parseFloat(env("SCREENER_CORE_SOL", "3")),     // size per CORE position
  SCREENER_HOT_SOL      : parseFloat(env("SCREENER_HOT_SOL", "1.5")),    // size per HOT position
  SCREENER_MAX_CORE     : parseInt(env("SCREENER_MAX_CORE", "4")),       // max concurrent CORE pools
  SCREENER_MAX_HOT      : parseInt(env("SCREENER_MAX_HOT", "2")),        // max concurrent HOT pools
  SCREENER_RESERVE_SOL  : parseFloat(env("SCREENER_RESERVE_SOL", "5")),  // never deploy below this free balance (on top of SOL_RESERVE)
  SCREENER_MIN_BIN_STEP : parseInt(env("SCREENER_MIN_BIN_STEP", "0")),       // v0.7.14 skip pools with a smaller bin step (0 = off)
  SCREENER_CORE_TVL_PCT : parseFloat(env("SCREENER_CORE_TVL_PCT", "0")),     // v0.7.12 CORE size = this % of pool TVL (0 = fixed CORE_SOL)
  SCREENER_CORE_MAX_SOL : parseFloat(env("SCREENER_CORE_MAX_SOL", "60")),    // v0.7.12 cap on the TVL-scaled CORE (1X) size
  SCREENER_MAX_TVL_PCT  : parseFloat(env("SCREENER_MAX_TVL_PCT", "5")),      // v0.7.12 hard ceiling: any pool holding <= this % of pool TVL (0 = off)
  SCREENER_MIN_MCAP_USD : parseFloat(env("SCREENER_MIN_MCAP_USD", "1000000")), // v0.7.11 live mcap check on entry (0 = off)
  SCREENER_MIN_STREAK   : parseInt(env("SCREENER_MIN_STREAK", "2")),     // pool must be CORE/HOT on this many consecutive hourly passes
  SCREENER_HARD_SL      : parseFloat(env("SCREENER_HARD_SL", "18")),     // stop-loss % (PnL incl. fees) — uses the existing hard-stop line
  SCREENER_DEPTH        : parseFloat(env("SCREENER_DEPTH", "60")),       // BidAsk ladder depth below price (%)
  SCREENER_DEPTH_HISTEP : parseFloat(env("SCREENER_DEPTH_HISTEP", "70")),// depth for bin step >= 125
  SCREENER_HOT_MIN_AGE_H: parseFloat(env("SCREENER_HOT_MIN_AGE_H", "0")), // v0.7.18 HOT opens/upgrades need token age >= this many hours (0 = off)
  SCREENER_DEPTH_CORE   : parseFloat(env("SCREENER_DEPTH_CORE", "0")),   // v0.7.17 per-tier depth % (CORE and CORE+), all bin steps (0 = use the lines above)
  SCREENER_DEPTH_HOT    : parseFloat(env("SCREENER_DEPTH_HOT", "0")),    // v0.7.17 per-tier depth % for HOT
  SCREENER_DEPTH_WATCH  : parseFloat(env("SCREENER_DEPTH_WATCH", "0")),  // v0.7.17 per-tier depth % for WATCH
  SCREENER_SHAPE_CORE   : env("SCREENER_SHAPE_CORE", "").toLowerCase(),   // v0.7.17 per-tier base shape: bidask | spot ("" = SCREENER_BASE_SHAPE)
  SCREENER_SHAPE_HOT    : env("SCREENER_SHAPE_HOT", "").toLowerCase(),
  SCREENER_SHAPE_WATCH  : env("SCREENER_SHAPE_WATCH", "").toLowerCase(),
  SCREENER_MAX_TAX_BPS  : parseFloat(env("SCREENER_MAX_TAX_BPS", "0")),  // skip coins with a transfer tax above this
  SCREENER_PICK_MAX_AGE_MIN: parseFloat(env("SCREENER_PICK_MAX_AGE_MIN", "90")), // ignore a stale picks file (screener down)
  SCREENER_OPENS_PER_PASS: parseInt(env("SCREENER_OPENS_PER_PASS", "2")),
  SCREENER_RECENTER_H   : parseFloat(env("SCREENER_RECENTER_H", "0")),
  SCREENER_PLUS_MULT    : parseFloat(env("SCREENER_PLUS_MULT", "2")),     // v0.7.2: CORE+ size = this x SCREENER_CORE_SOL (1 = off)
  SCREENER_PLUS_TOPUP   : env("SCREENER_PLUS_TOPUP", "true") === "true",  // top held pools up to CORE+ size when they turn CORE+
  SCREENER_BASE_SHAPE   : env("SCREENER_BASE_SHAPE", "bidask").toLowerCase(), // v0.7.9: "spot" = base legs are Spot instead of BidAsk (screenerlp2 A/B). THIS copy (screenerlp) defaults to BidAsk
  SCREENER_BASE_SPOT_DEPTH: parseFloat(env("SCREENER_BASE_SPOT_DEPTH", "80")),  // depth of those Spot base legs (%)
  SCREENER_MAX_NEW_BIN_ARRAYS: parseFloat(env("SCREENER_MAX_NEW_BIN_ARRAYS", "0")), // v0.7.10: new (non-refundable) bin arrays an open may create; beyond -> ladder cut back
  SCREENER_MIN_DEPTH_PCT: parseFloat(env("SCREENER_MIN_DEPTH_PCT", "20")),         // v0.7.10: cut-back ladder shallower than this % -> skip the open
  SCREENER_PLUS_SHAPE   : env("SCREENER_PLUS_SHAPE", "bidask").toLowerCase(),   // v0.7.3: "spot" = CORE+ extra size goes in as a Spot leg
  SCREENER_PLUS_SPOT_DEPTH: parseFloat(env("SCREENER_PLUS_SPOT_DEPTH", "80")), // Spot leg range: just below price down this % 
  SCREENER_PLUS_MIN_MOM : parseFloat(env("SCREENER_PLUS_MIN_MOM", "1.0")),     // top-ups need mom >= this
  SCREENER_TOPUP_PACE_CHECK: env("SCREENER_TOPUP_PACE_CHECK", "true") === "true", // top-ups need pace4h >= pace4h at our first open
  SCREENER_WATCH_MULT   : parseFloat(env("SCREENER_WATCH_MULT", "0.33")),   // v0.7.4: WATCH open size = this x CORE (0 = no WATCH opens)
  SCREENER_MAX_WATCH    : parseInt(env("SCREENER_MAX_WATCH", "6")),          // max concurrent WATCH-sized pools
  SCREENER_WATCH_MIN_PACE: parseFloat(env("SCREENER_WATCH_MIN_PACE", "4")),
  SCREENER_LOWPACE_MULT : parseFloat(env("SCREENER_LOWPACE_MULT", "0.5")),  // v0.7.16 aged pool below the screener's normal pace line: CORE sized at this x (0 = off)
  SCREENER_WATCH_MIN_PACE_AGED: parseFloat(env("SCREENER_WATCH_MIN_PACE_AGED", "2")), // v0.7.16 same, for tokens the screener marks aged (7d+)  // clean WATCH = pace4h >= this and no slow/fading count
  SCREENER_MAX_POOLS_PER_MINT: parseInt(env("SCREENER_MAX_POOLS_PER_MINT", "2")), // 2nd pool only while the token is listed 2+ times
  SCREENER_MAX_SOL_PER_MINT: parseFloat(env("SCREENER_MAX_SOL_PER_MINT", "0")), // total SOL cap per token across its pools (0 = off)
  SCREENER_TRIM_PCT     : parseFloat(env("SCREENER_TRIM_PCT", "25")),     // trim this % when a held pool heads toward EXIT (0 = off)
  SCREENER_TRIM_KEEP_PACE: parseFloat(env("SCREENER_TRIM_KEEP_PACE", "3")),// no trim while pace4h is still >= this %/day
  SCREENER_TRIM_MIN_SOL : parseFloat(env("SCREENER_TRIM_MIN_SOL", "0.3")),// skip trims smaller than this (fees/rent not worth it)   // v0.7.1: price above the ladder this many hours -> close; reopen at new price if still CORE/HOT (0 = off)
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
//   smallcap=1000000 smallmax=3   coins under $1M mcap open at most 3 SOL (overrides SMALLCAP_*)
//   taxfee=25 taxwin=1h           taxed coins (>= TAXFEE_MIN_TAX_BPS) need 25%/day fee pace over 1h (overrides TAXFEE_*)
//   shaperule=off                 exempt this wallet from the v0.6.15 BidAsk-forcing shape rule
//   width=source  mirror their exact ladder: no tiered width floor and no MIN_RANGE_DEPTH_PCT extension
//   group=fast    assign wallet to a budget group; GROUP_BUDGETS=fast:80 caps that group's combined
//                 open exposure at 80 SOL
// e.g. self-follow: MyScoutWallet:fixed=30:min=1 · percent-follow: Whale:pct=25:max=25
//      launch sniper: 9mCE…:pct=99:max=10:sl=off:hard=18:follow=source:width=source:age=0:mcap=0:feetvl=0
const TARGET_CFG = CFG.TARGET_WALLETS.split(",").map(s => s.trim()).filter(Boolean).map(s => {
  const parts = s.split(":");
  const t = { addr: parts[0], maxSol: null, fixedSol: null, minDep: null, pct: null, lowMcapSol: null,
              slPct: null, hotPct: null, hardPct: null, follow: null, oorUpMin: null,
              minAgeH: null, minMcapUsd: null, minJup: null, minFeeTvl: null, maxTaxBps: null, width: null, group: null, followAdds: false };
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
      else if (k === "jup") t.minJup = parseFloat(v);                        // per-wallet jup organic-score gate (0 = off)
      else if (k === "width") t.width = v;                                   // width=source: no width floor / depth extension
      else if (k === "adds") t.followAdds = v === "on";
      else if (k === "smallcap") t.smallCapUsd = parseFloat(v);              // small-cap threshold USD for this wallet (0 = off)
      else if (k === "smallmax") t.smallMaxSol = parseFloat(v);              // max open size under smallcap
      else if (k === "taxfee") t.taxFeePct = parseFloat(v);                  // fee/TVL %/day floor for taxed coins (0 = off)
      else if (k === "taxwin") t.taxFeeWin = v;                              // window for the taxfee check
      else if (k === "shaperule") t.shapeRuleOff = v === "off";              // shaperule=off: always mirror this wallet's shape                      // adds=on: mirror the source ADDING liquidity to a position we already copied (layered shapes)
      else if (k === "tax") t.maxTaxBps = parseFloat(v);                     // per-wallet transfer-tax ceiling in bps (0 = off)
      else if (k === "feetvl") t.minFeeTvl = parseFloat(v);                  // per-wallet pool fee/TVL gate (0 = off)
      else if (k === "group") t.group = v;                                   // budget group name (see GROUP_BUDGETS)
    } else if (p) t.maxSol = parseFloat(p); // legacy bare number = max
  }
  return t;
});
if (CFG.SCREENER_PICKS)
  TARGET_CFG.push({ addr: "SCREENER", maxSol: null, fixedSol: null, minDep: null, pct: null, lowMcapSol: null,
    slPct: 0, hotPct: 0, hardPct: CFG.SCREENER_HARD_SL, follow: "source", oorUpMin: -1,
    minAgeH: null, minMcapUsd: null, minJup: null, minFeeTvl: null, maxTaxBps: null, width: null, group: null, followAdds: false });
const TARGETS = TARGET_CFG.filter(t => t.addr !== "SCREENER").map(t => t.addr);
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
if (!TARGETS.length && !CFG.SCREENER_PICKS) { console.error("TARGET_WALLETS is empty (and SCREENER_PICKS not set)"); process.exit(1); }

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
  if (process.argv.some(a => a.startsWith("--close") || a === "--version")) return; // short deliberate CLI runs
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
  let t = c && Date.now() - c.at < 15 * 60_000 ? c.t : null;
  if (!t) {
    try {
      const r = await jfetch(`${CFG.JUP}/tokens/v2/search?query=${mint}`).then(x => x.json());
      t = Array.isArray(r) ? r.find(x => x.id === mint) : null;
      tokenCache.set(mint, { at: Date.now(), t });
    } catch {}
  }
  if (!t) return { ok: true, note: "no token data (gate skipped)" };
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

const FEE_WIN_HOURS = { "30m": 0.5, "1h": 1, "2h": 2, "4h": 4, "12h": 12, "24h": 24 };
const feePaceCache = new Map();
async function poolFeePace(poolAddr, win) {
  // returns fee/TVL % extrapolated to a 24h pace over the chosen window, or null if unavailable
  const k = poolAddr + ":" + win;
  const c = feePaceCache.get(k);
  if (c && Date.now() - c.at < 5 * 60_000) return c.v;
  let v = null;
  try {
    const j = await fetch(`${CFG.DATAPI}/pools?query=${poolAddr}&page_size=5`, { headers: UA }).then(x => x.json());
    const p = (j.data || []).find(x => x.address === poolAddr);
    const h = FEE_WIN_HOURS[win];
    if (p && p.tvl > 0 && h) {
      const fees = p.fees?.[win];
      if (fees != null) v = (fees / p.tvl) * 100 * (24 / h);
    }
  } catch {}
  feePaceCache.set(k, { at: Date.now(), v });
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
          await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer], { commitment: "confirmed" }), "add send");
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
const _mirrorFails = new Map(); // target:srcPos -> failed attempt count
async function mirrorOpen(target, src) {
  const tag = target.slice(0, 6);
  // dedupe race guard: realtime + backfill can deliver the same source position ~simultaneously
  const ifKey = target + ":" + src.pos;
  if (_inflight.has(ifKey)) return;
  _inflight.add(ifKey);
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
  } finally { _inflight.delete(ifKey); }
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
  if (CFG.MAX_OPENS_PER_MINT) {
    const winMs = CFG.MINT_OPEN_WINDOW_MIN * 60000;
    const since = Date.now() - winMs;
    // counts every mirror we opened on this mint inside the window — open OR already closed,
    // any source wallet — so rapid source cycling can't re-enter us over and over
    const recent = Object.values(S.mine).filter(m => m.mint === src.mint && m.ts >= since).length;
    if (recent >= CFG.MAX_OPENS_PER_MINT)
      return log(`  [${tag}] skip: ${recent} open(s) on this mint in last ${CFG.MINT_OPEN_WINDOW_MIN}m (rate cap ${CFG.MAX_OPENS_PER_MINT}) — churn guard`);
  }
  if (S.paused?.[target]) return log(`  [${tag}] skip: target paused`);
  const spLeft = spikeBlockLeft(src.pool);
  if (spLeft > 0)
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: fee spike on this pool (${S.spikePools[src.pool].rate}%/30m) — opens blocked ${Math.ceil(spLeft / 60000)}m more`);
  const q = await tokenGate(src.tokenX, TCFG[target] || {});
  if (!q.ok) return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${q.why}`);
  if (q.note) log(`  [${tag}] note: ${q.note}`);
  if (q.lowMcap) log(`  [${tag}] low-mcap coin ($${(q.mcap / 1e6).toFixed(2)}M < $${CFG.MIN_MCAP_USD / 1e6}M) — sizing down to ${(TCFG[target] || {}).lowMcapSol} SOL fixed`);
  const fg = await poolFeeGate(src.pool, TCFG[target] || {});
  if (!fg.ok) return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: ${fg.why}`);
  if (fg.note) log(`  [${tag}] note: ${fg.note}`);
  if (fg.pct !== undefined) log(`  [${tag}] pool fee/TVL ${fg.pct.toFixed(2)}%/24h — pass`);
  { // v0.6.14 taxed-coin fee floor
    const tO = TCFG[target] || {};
    const minPct = tO.taxFeePct != null ? tO.taxFeePct : CFG.TAXFEE_MIN_PCT;
    if (minPct > 0) {
      const taxBps = q.taxBps != null ? q.taxBps : await tokenTaxBps(src.tokenX);
      if (taxBps >= CFG.TAXFEE_MIN_TAX_BPS) {
        const win = tO.taxFeeWin || CFG.TAXFEE_WINDOW;
        const pace = await poolFeePace(src.pool, win);
        if (pace == null)
          return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: tax ${(taxBps / 100).toFixed(2)}% coin but no fee data for the ${win} window — failing closed`);
        if (pace < minPct)
          return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: tax ${(taxBps / 100).toFixed(2)}% coin needs fee/TVL >= ${minPct}%/day — pool pace ${pace.toFixed(2)}%/day (${win} window)`);
        log(`  [${tag}] tax ${(taxBps / 100).toFixed(2)}% coin — pool pace ${pace.toFixed(2)}%/day (${win}) >= ${minPct}% — pass`);
      }
    }
  }

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
  if (totalValSol > 0 && xValSol / totalValSol > 0.30)
    return log(`  [${tag}] skip ${src.pos.slice(0, 6)}: token side is ${(100 * xValSol / totalValSol).toFixed(0)}% of value — not a fresh bid ladder`);
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
  { // v0.6.14 small-cap size cap
    const scUsd = tOv.smallCapUsd != null ? tOv.smallCapUsd : CFG.SMALLCAP_MCAP_USD;
    const scMax = tOv.smallMaxSol != null ? tOv.smallMaxSol : CFG.SMALLCAP_MAX_SOL;
    if (scUsd > 0 && scMax > 0 && sol > scMax && (q.mcap == null || q.mcap < scUsd)) {
      log(`  [${tag}] small-cap (${q.mcap == null ? "mcap unknown" : "$" + (q.mcap / 1e6).toFixed(2) + "M"} < $${(scUsd / 1e6).toFixed(2)}M) — capping ${sol.toFixed(2)} -> ${scMax} SOL`);
      sol = scMax;
    }
  }
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
  let applyShape = CFG.SHAPE_MIRROR && (!wide || CFG.SHAPE_ON_WIDE);
  if (CFG.SHAPE_MIRROR)
    log(`  [${tag}] shape: source=${shape.name}${shape.ratio != null ? ` (far/near ${shape.ratio.toFixed(2)})` : " (fallback)"}` +
        `${applyShape ? "" : ` — wide path unverified, opening BidAsk`}`);
  // v0.6.15 shape rule: Spot/Curve only where your history says it pays (calm pools, lower bin step)
  if (applyShape && shape.name !== "BidAsk" && CFG.SHAPE_RULE && !(TCFG[target] || {}).shapeRuleOff) {
    let why = null;
    if (step >= CFG.SHAPE_RULE_STEP) why = `bin step ${step} >= ${CFG.SHAPE_RULE_STEP}`;
    else {
      const pace = await poolFeePace(src.pool, CFG.SHAPE_RULE_WINDOW);
      if (pace != null && pace >= CFG.SHAPE_RULE_PACE) why = `pool pace ${pace.toFixed(1)}%/day (${CFG.SHAPE_RULE_WINDOW}) >= ${CFG.SHAPE_RULE_PACE}%`;
      else log(`  [${tag}] shape rule: step ${step}, pace ${pace == null ? "n/a" : pace.toFixed(1) + "%/day"} — calm pool, keeping ${shape.name}`);
    }
    if (why) { log(`  [${tag}] shape rule: ${why} — forcing BidAsk instead of ${shape.name}`); applyShape = false; }
  }
  const strategyType = applyShape ? shape.strategyType : StrategyType.BidAsk;

  log(`  [${tag}] MIRROR ${src.pos.slice(0, 6)}: ${src.tokenX.slice(0, 6)}-SOL bins ${minBin}..${maxBin} (${widthPct.toFixed(1)}% wide), ` +
      `their ${ySol.toFixed(1)} SOL -> our ${sol.toFixed(2)} SOL [${applyShape ? shape.name : "BidAsk"}]` +
      (q.taxBps ? ` TAX ${(q.taxBps / 100).toFixed(2)}%/transfer (~${(2 * q.taxBps / 100).toFixed(1)}% round-trip if filled)` : ""));
  if (CFG.DRY_RUN) { log("  [dry-run] not sent"); return { dry: true }; }

  const totalY = new BN(Math.floor(sol * LAMPORTS_PER_SOL));
  const strategy = { minBinId: minBin, maxBinId: maxBin, strategyType };
  const opened = [];
  if (maxBin - minBin + 1 <= 69) {
    // single atomic tx (init + add together) — any failure is a clean failure, so the
    // 0x1774 active-bin slippage race is retried unconditionally with doubled tolerance
    for (let attempt = 0; ; attempt++) {
      const slip = Math.min(CFG.WIDE_SLIPPAGE_PCT * 2 ** attempt, 100);
      const posKp = Keypair.generate();
      registerPending(posKp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: applyShape ? shape.name : "BidAsk" });
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
            for (const kp of kps) registerPending(kp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: applyShape ? shape.name : "BidAsk" });
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
                shape: applyShape ? shape.name : "BidAsk",
                ts: Date.now(), oorSince: null, closed: false };
              save();
              continue; // move on to the next chunk — do not abort the ladder
            }
            throw e;
          }
          opened.push(chunkAddr); pendingChunks.delete(chunkAddr);
          S.mine[chunkAddr] = { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX,
            minBin, maxBin, step, solIn: sol / resp.instructionsByPositions.length,
            shape: applyShape ? shape.name : "BidAsk",
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
  log(`  [${tag}] OPENED ${opened.length} position account(s) covering bins ${minBin}..${maxBin}`);
  for (const addr of opened) {
    const e = (S.mine[addr] = S.mine[addr] || { pool: src.pool, mint: src.tokenX, minBin, maxBin, step, ts: Date.now(), oorSince: null, closed: false });
    // ALWAYS (re)write linkage: if the orphan sweep adopted this address seconds before we got here,
    // the entry exists with target=null — the old `||` kept that and silently orphaned the position.
    e.target = target; e.srcPos = src.pos; e.orphan = false; e.closed = false;
    if (e.minBin == null) { e.minBin = minBin; e.maxBin = maxBin; e.step = step; }
    pendingChunks.delete(addr);
    e.shape = applyShape ? shape.name : "BidAsk";
    e.solIn = sol / opened.length;
    e.siblings = opened.length > 1 ? opened.filter(a => a !== addr) : [];
    if (TCFG[target]?.followAdds) {
      const primary = addr === opened[0];
      e.addPrimary = primary;
      if (primary) { const sn = snapSrcBins(d.positionBinData); e.srcSnap = sn.bins; e.srcVal = sn.total; e.srcDepSol = null; } // deposit baseline set on first adds check (datapi)
    }
  }
  save();
}

// ============================================================ v0.7.0 screener mode ===
// Opens BidAsk ladders in pools the screener rates CORE/HOT, closes them when the screener says the
// pool's fees slowed / LPs left / it fell out of the filters. Stop-loss is the existing hard line
// (SCREENER_HARD_SL). Everything else (range drift, OOR) is left to you — positions are "held".
async function screenerOpen(pick, sol, label = "OPEN", legShape = "BidAsk") {
  return ledgerRun({ pool: pick.addr, mint: pick.mint, sym: pick.sym, open: true }, async () => {
    const W = wlState(), pre = W.active[pick.addr];
    const legs = () => Object.values(S.mine).filter(m => !m.closed && m.pool === pick.addr).length;
    const before = legs();
    const r = await screenerOpenImpl(pick, sol, label, legShape);
    const id = W.active[pick.addr] || pre;
    if (id && W.eps[id] && legs() > before && !CFG.DRY_RUN) { W.eps[id].depositSol += sol; save(); }
    return r;
  });
}
// v0.7.12 live pool stats (Meteora data API): { mcap, tvl, solUsd } or null. Cached 10 min.
const _livePool = new Map();
async function livePool(poolAddr, fresh = false) {
  const c = _livePool.get(poolAddr);
  if (!fresh && c && Date.now() - c.at < 10 * 60_000) return c.v;
  let v = null;
  try {
    const j = await fetch(`${CFG.DATAPI}/pools?query=${poolAddr}&page_size=5`, { headers: UA }).then(x => x.json());
    const p = (j.data || []).find(x => x.address === poolAddr);
    if (p) {
      const WS = "So11111111111111111111111111111111111111112";
      const solUsd = p.token_y?.address === WS ? +p.token_y.price : p.token_x?.address === WS ? +p.token_x.price : NaN;
      v = { mcap: +(p.token_x?.market_cap) || null, tvl: +p.tvl || null, solUsd: Number.isFinite(solUsd) && solUsd > 0 ? solUsd : null };
    }
  } catch {}
  _livePool.set(poolAddr, { at: Date.now(), v });
  return v;
}
// v0.7.11 live token mcap (now via livePool; fresh read at entry)
async function liveMcap(poolAddr) {
  const v = await livePool(poolAddr, true);
  return v && v.mcap > 0 ? v.mcap : null;
}
// v0.7.12 size for a pool: CORE scales with TVL (floor CORE_SOL, cap CORE_MAX_SOL, x PLUS_MULT when plus);
// every tier is capped at SCREENER_MAX_TVL_PCT of pool TVL. Falls back to baseSol if TVL is unknown.
async function scrSizeFor(p, baseSol, plus, plusMult) {
  if (!(CFG.SCREENER_CORE_TVL_PCT > 0) && !(CFG.SCREENER_MAX_TVL_PCT > 0)) return baseSol;
  const lp = await livePool(p.addr);
  if (!lp || !lp.tvl || !lp.solUsd) return baseSol;
  const tvlSol = lp.tvl / lp.solUsd;
  let sol = baseSol;
  if (p.tier === "CORE" && CFG.SCREENER_CORE_TVL_PCT > 0) {
    const core = Math.min(Math.max(CFG.SCREENER_CORE_SOL, tvlSol * CFG.SCREENER_CORE_TVL_PCT / 100), CFG.SCREENER_CORE_MAX_SOL);
    sol = core * (plus ? plusMult : 1);
  }
  if (CFG.SCREENER_MAX_TVL_PCT > 0) sol = Math.min(sol, tvlSol * CFG.SCREENER_MAX_TVL_PCT / 100);
  return +sol.toFixed(2);
}
// v0.7.18 token age in hours from Jupiter's first-pool timestamp (null = unknown); shares tokenGate's cache
async function scrTokenAgeH(mint) {
  const c = tokenCache.get(mint);
  let t = c && Date.now() - c.at < 15 * 60_000 ? c.t : null;
  if (!t) {
    try {
      const r = await jfetch(`${CFG.JUP}/tokens/v2/search?query=${mint}`).then(x => x.json());
      t = Array.isArray(r) ? r.find(x => x.id === mint) : null;
      tokenCache.set(mint, { at: Date.now(), t });
    } catch {}
  }
  const ts = t && t.firstPool && t.firstPool.createdAt ? new Date(t.firstPool.createdAt).getTime() : NaN;
  return Number.isFinite(ts) ? (Date.now() - ts) / 3.6e6 : null;
}
// v0.7.17 per-tier base shape ("spot" | "bidask"); falls back to SCREENER_BASE_SHAPE
function scrTierShape(tier) {
  const v = tier === "CORE" ? CFG.SCREENER_SHAPE_CORE : tier === "HOT" ? CFG.SCREENER_SHAPE_HOT : tier === "WATCH" ? CFG.SCREENER_SHAPE_WATCH : "";
  return v === "spot" || v === "bidask" ? v : CFG.SCREENER_BASE_SHAPE;
}
// v0.7.17 per-tier base-leg depth; 0 = tier not configured (fall back to SCREENER_DEPTH etc.)
function scrTierDepth(tier) {
  const v = tier === "CORE" ? CFG.SCREENER_DEPTH_CORE : tier === "HOT" ? CFG.SCREENER_DEPTH_HOT : tier === "WATCH" ? CFG.SCREENER_DEPTH_WATCH : 0;
  return v > 0 && v < 100 ? v : 0;
}
async function screenerOpenImpl(pick, sol, label = "OPEN", legShape = "BidAsk") {
  if (String(label).startsWith("OPEN") && CFG.SCREENER_MIN_MCAP_USD > 0) {      // v0.7.11 entry-only mcap check
    const mc = await liveMcap(pick.addr);
    const k = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1e3)}k`;
    if (mc == null) log(`  [SCRN] ${pick.sym}: live mcap unavailable — opening on the screener's check`);
    else if (mc < CFG.SCREENER_MIN_MCAP_USD) {
      log(`  [SCRN] skip ${pick.sym}: mcap ${k(mc)} < ${k(CFG.SCREENER_MIN_MCAP_USD)} (live check on entry)`);
      throw new Error(`mcap ${k(mc)} below ${k(CFG.SCREENER_MIN_MCAP_USD)} (live check)`);
    } else log(`  [SCRN] ${pick.sym}: live mcap ${k(mc)} — pass`);
  }
  const spotMode = scrTierShape(pick.tier) === "spot";                            // v0.7.17 per-tier shape
  if (legShape === "Spot" && pick.tier !== "CORE" && !spotMode) legShape = "BidAsk"; // v0.7.17 old Spot leg of a now-BidAsk HOT/WATCH tier reopens as BidAsk
  const plusSpotLeg = legShape === "Spot" && !spotMode;                            // CORE+ Spot leg of a BidAsk-base tier
  const baseAsSpot = legShape === "BidAsk" && spotMode;   // v0.7.9 A/B
  if (pick.tier === "HOT" && CFG.SCREENER_HOT_MIN_AGE_H > 0 && /^(OPEN|UPGRADE)/.test(String(label))) {   // v0.7.18
    const ageH = await scrTokenAgeH(pick.mint);
    if (ageH == null) { log(`  [SCRN] skip HOT ${pick.sym}: token age unknown (SCREENER_HOT_MIN_AGE_H ${CFG.SCREENER_HOT_MIN_AGE_H}h)`); throw new Error("HOT: token age unknown"); }
    if (ageH < CFG.SCREENER_HOT_MIN_AGE_H) { log(`  [SCRN] skip HOT ${pick.sym}: token ${ageH.toFixed(0)}h old < ${CFG.SCREENER_HOT_MIN_AGE_H}h (SCREENER_HOT_MIN_AGE_H)`); throw new Error(`HOT: token ${ageH.toFixed(0)}h < ${CFG.SCREENER_HOT_MIN_AGE_H}h`); }
  }
  if (baseAsSpot) legShape = "Spot";
  const target = "SCREENER", tag = "SCRN";
  const src = { pos: "screener:" + pick.addr, pool: pick.addr, tokenX: pick.mint };
  if (spikeBlockLeft(pick.addr) > 0) throw new Error(`pool is fee-spiking (${S.spikePools[pick.addr].rate}%/30m) — open blocked`);
  const dlmm = await getDlmm(pick.addr);
  await withRetry(() => dlmm.refetchStates(), "scr refetch", 2).catch(() => {});
  const activeId = dlmm.lbPair.activeId;
  const step = dlmm.lbPair.binStep;
  if (CFG.SCREENER_MIN_BIN_STEP > 0 && step < CFG.SCREENER_MIN_BIN_STEP) {   // v0.7.14
    log(`  [SCRN] skip ${pick.sym}: bin step ${step} < ${CFG.SCREENER_MIN_BIN_STEP} (SCREENER_MIN_BIN_STEP)`);
    throw new Error(`bin step ${step} below ${CFG.SCREENER_MIN_BIN_STEP}`);
  }
  const isSpotLeg = legShape === "Spot";
  const tierDepth = scrTierDepth(pick.tier);                                    // v0.7.17 per-tier depth (0 = not set)
  const depth = tierDepth > 0 ? (plusSpotLeg ? CFG.SCREENER_PLUS_SPOT_DEPTH : tierDepth)
              : baseAsSpot ? CFG.SCREENER_BASE_SPOT_DEPTH : isSpotLeg ? CFG.SCREENER_PLUS_SPOT_DEPTH : (step >= 125 ? CFG.SCREENER_DEPTH_HISTEP : CFG.SCREENER_DEPTH);
  const bins = Math.max(2, Math.ceil(Math.log(1 / (1 - depth / 100)) / Math.log(1 + step / 10000)));
  const maxBin = activeId - 1;
  let minBin = maxBin - bins + 1;
  minBin = await binArrayGuard(dlmm, minBin, maxBin, step, pick.sym);    // v0.7.10: never pay for new bin arrays (throws to skip)
  const shape = isSpotLeg ? { name: "Spot", strategyType: StrategyType.Spot } : { name: "BidAsk", strategyType: StrategyType.BidAsk };
  const applyShape = isSpotLeg;
  const strategyType = shape.strategyType;
  log(`  [${tag}] ${label} ${pick.plus ? "CORE+" : pick.tier} ${pick.sym} (${pick.addr.slice(0, 6)}): ${shape.name} ${(100 * (1 - Math.pow(1 + step / 10000, -(maxBin - minBin + 1)))).toFixed(0)}% deep, bins ${minBin}..${maxBin} (${maxBin - minBin + 1} bins, step ${step}), ${sol} SOL | pace4h ${pick.pace4}% mom ${pick.mom} streak ${pick.streak}`);
  if (CFG.DRY_RUN) { log("  [dry-run] not sent"); return; }
  const totalY = new BN(Math.floor(sol * LAMPORTS_PER_SOL));
  const strategy = { minBinId: minBin, maxBinId: maxBin, strategyType };
  const opened = [];
  if (maxBin - minBin + 1 <= 69) {
    // single atomic tx (init + add together) — any failure is a clean failure, so the
    // 0x1774 active-bin slippage race is retried unconditionally with doubled tolerance
    for (let attempt = 0; ; attempt++) {
      const slip = Math.min(CFG.WIDE_SLIPPAGE_PCT * 2 ** attempt, 100);
      const posKp = Keypair.generate();
      registerPending(posKp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: applyShape ? shape.name : "BidAsk" });
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
            for (const kp of kps) registerPending(kp.publicKey.toBase58(), { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX, minBin, maxBin, step, shape: applyShape ? shape.name : "BidAsk" });
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
                shape: applyShape ? shape.name : "BidAsk",
                ts: Date.now(), oorSince: null, closed: false };
              save();
              continue; // move on to the next chunk — do not abort the ladder
            }
            throw e;
          }
          opened.push(chunkAddr); pendingChunks.delete(chunkAddr);
          S.mine[chunkAddr] = { target, srcPos: src.pos, pool: src.pool, mint: src.tokenX,
            minBin, maxBin, step, solIn: sol / resp.instructionsByPositions.length,
            shape: applyShape ? shape.name : "BidAsk",
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
  log(`  [${tag}] OPENED ${opened.length} position account(s) covering bins ${minBin}..${maxBin}`);
  for (const addr of opened) {
    const e = (S.mine[addr] = S.mine[addr] || { pool: src.pool, mint: src.tokenX, minBin, maxBin, step, ts: Date.now(), oorSince: null, closed: false });
    // ALWAYS (re)write linkage: if the orphan sweep adopted this address seconds before we got here,
    // the entry exists with target=null — the old `||` kept that and silently orphaned the position.
    e.target = target; e.srcPos = src.pos; e.orphan = false; e.closed = false;
    if (e.minBin == null) { e.minBin = minBin; e.maxBin = maxBin; e.step = step; }
    pendingChunks.delete(addr);
    e.shape = applyShape ? shape.name : "BidAsk";
    e.solIn = sol / opened.length;
    e.siblings = opened.length > 1 ? opened.filter(a => a !== addr) : [];
    if (TCFG[target]?.followAdds) {
      const primary = addr === opened[0];
      e.addPrimary = primary;
      if (primary) { const sn = snapSrcBins(d.positionBinData); e.srcSnap = sn.bins; e.srcVal = sn.total; e.srcDepSol = null; } // deposit baseline set on first adds check (datapi)
    }
  }  await calibrateChunks(dlmm, opened, minBin, maxBin);   // v0.7.10: real per-chunk bins + deposits

  for (const a of opened) if (S.mine[a]) {
    const mm = S.mine[a];
    mm.scrTier = pick.tier; mm.scrSym = pick.sym; mm.shape = shape.name;
    if (!label.startsWith("OPEN")) mm.scrTopup = true;
    if (mm.scrPace0 == null) mm.scrPace0 = pick.pace4 ?? null;   // v0.7.3: pace at open, for the top-up gate
    if (!mm.ts) mm.ts = Date.now();
  }
  save();
}

// v0.7.3 per-shape ledger for screener legs: closed/wins/net and SOL-days, so BidAsk vs Spot can be
// compared on net PnL per SOL-day (fees AND inventory). Separate buckets — never trigger auto-pause.
function scrShapeStat(m, pnlSol, closedNow) {
  ledgerTrackerAdd(m, pnlSol);
  if (m.target !== "SCREENER") return;
  S.stats = S.stats || {};
  const key = "SCREENER:" + (m.shape || "BidAsk");
  const st = (S.stats[key] = S.stats[key] || { closed: 0, wins: 0, netPnlSol: 0, solDays: 0, recent: [] });
  st.netPnlSol += pnlSol;
  if (closedNow) {
    st.closed++; if ((+m.lastPnl || 0) > 0) st.wins++;
    st.solDays += (m.solIn || 0) * Math.max(0, Date.now() - (m.ts || Date.now())) / 86400e3;
    st.recent.push(+(+m.lastPnl || 0).toFixed(2)); if (st.recent.length > 20) st.recent.shift();
    log(`  [SCRN] ${m.shape || "BidAsk"} legs: ${st.closed} closed, ${st.wins} wins, net ${st.netPnlSol >= 0 ? "+" : ""}${st.netPnlSol.toFixed(3)} SOL` +
        (st.solDays > 0 ? `, ${(100 * st.netPnlSol / st.solDays).toFixed(2)}% per SOL-day` : ""));
  }
}
function scrShapeSummary() {
  const out = [];
  for (const k of ["SCREENER:BidAsk", "SCREENER:Spot"]) {
    const st = (S.stats || {})[k]; if (!st) continue;
    out.push(`${k.split(":")[1]} ${st.closed} closed net ${st.netPnlSol >= 0 ? "+" : ""}${st.netPnlSol.toFixed(3)} SOL` + (st.solDays > 0 ? ` (${(100 * st.netPnlSol / st.solDays).toFixed(2)}%/SOL-day)` : ""));
  }
  return out.join(" | ");
}

// v0.7.2 graceful exit: withdraw pct% of every position we hold in a pool (keeps the ladder shape,
// fees stay on the position), sell the token side to SOL. PnL stays continuous: the basis shrinks by
// pct% and the same share of earned fees is banked, so SL lines and stats keep working unchanged.
async function screenerTrim(pool, list, pct, why) {
  const m0 = (list[0] || [])[1] || {};
  return ledgerRun({ pool, mint: m0.mint, sym: m0.scrSym }, () => screenerTrimImpl(pool, list, pct, why));
}
async function screenerTrimImpl(pool, list, pct, why) {
  const sym = list[0][1].scrSym || pool.slice(0, 6);
  // v0.7.3: take the trim out of Spot legs first. plan = [addr, m, pctForThisPosition]
  const solOf = arr => arr.reduce((a, [, m]) => a + (m.solIn || 0), 0);
  const spot = list.filter(([, m]) => m.shape === "Spot"), base = list.filter(([, m]) => m.shape !== "Spot");
  let need = solOf(list) * pct / 100;
  const plan = [];
  const spotSol = solOf(spot);
  if (spot.length && spotSol > 0) {
    const f = Math.min(1, need / spotSol);
    for (const [a, m] of spot) plan.push([a, m, 100 * f]);
    need -= spotSol * f;
  }
  const baseSol = solOf(base);
  if (need > 1e-6 && baseSol > 0) { const f = Math.min(1, need / baseSol); for (const [a, m] of base) plan.push([a, m, 100 * f]); }
  log(`  [SCRN] TRIM ${pct}% ${sym} (${list.length} position(s)${spot.length ? `, Spot leg first` : ""}): ${why}`);
  if (CFG.DRY_RUN) { for (const [, m] of list) m.scrTrimmed = Date.now(); save(); log("  [dry-run] not executed"); return true; }
  const dlmm = await getDlmm(pool);
  let done = 0;
  for (const [addr, m, legPct] of plan) {
    if (m.closed || closingNow.has(addr) || legPct < 0.5) continue;
    if (legPct >= 99.5) {                                    // whole leg goes: a normal close (ledger + sell)
      await closeMine(addr, m, `screener TRIM: ${m.shape || "BidAsk"} leg out first`, { skipSell: true }).catch(e => log(`  [SCRN] trim close error: ${e.message.slice(0, 80)}`));
      if (m.closed) done++;
      continue;
    }
    const bps = Math.round(legPct * 100);
    closingNow.add(addr);                                  // keep guards/closes off this position mid-trim
    try {
      const p = await withRetry(() => dlmm.getPosition(new PublicKey(addr)), "trim getPosition");
      const d = p.positionData;
      if (String(d.totalXAmount) === "0" && String(d.totalYAmount) === "0") continue;
      const price = parseFloat((await dlmm.getActiveBin()).price || "0");
      const unclaimed = (Number(d.feeX) * price + Number(d.feeY)) / LAMPORTS_PER_SOL;
      const claimed = m.feesClaimedRealSol != null ? m.feesClaimedRealSol
        : (Number(d.totalClaimedFeeXAmount) * price + Number(d.totalClaimedFeeYAmount)) / LAMPORTS_PER_SOL;
      const fees = unclaimed + claimed - (m.feesBaseSol || 0);
      const txs = await dlmm.removeLiquidity({
        position: new PublicKey(addr), user: signer.publicKey,
        fromBinId: d.lowerBinId, toBinId: d.upperBinId,
        bps: new BN(bps), shouldClaimAndClose: false,
      });
      for (const tx of Array.isArray(txs) ? txs : [txs])
        await withRetry(() => sendAndConfirmTransaction(conn, withPriority(tx), [signer], { commitment: "confirmed" }), "trim send");
      // bank the trimmed share: ledger gets its pnl, basis and fee baseline shrink by the same fraction
      const f = legPct / 100, adj = fees * f;
      if (Number.isFinite(+m.lastPnl) && m.solIn > 0) {
        S.stats = S.stats || {};
        const st = (S.stats[m.target] = S.stats[m.target] || { closed: 0, wins: 0, netPnlSol: 0, recent: [] });
        st.netPnlSol += m.solIn * f * (+m.lastPnl) / 100;
        scrShapeStat(m, m.solIn * f * (+m.lastPnl) / 100, false);
      }
      m.solIn = (m.solIn || 0) * (1 - f);
      m.feesBaseSol = (m.feesBaseSol || 0) + adj;
      m.feesSnapTs = Date.now(); m.feesSnapSol = fees - adj;
      m.scrTrimmed = Date.now();
      done++;
      save();
    } catch (e) { log(`  [SCRN] trim ${addr.slice(0, 8)}… failed: ${(e.message || "").slice(0, 90)}`); }
    finally { closingNow.delete(addr); }
  }
  if (done) { await ultraSellAll(list[0][1].mint).catch(e => log(`  [SCRN] trim sell: ${e.message.slice(0, 80)}`)); await unwrapWsol().catch(() => {}); }
  for (const [, m] of list) if (!m.closed) m.scrTrimmed = m.scrTrimmed || Date.now();
  save();
  log(`  [SCRN] TRIMMED ${done}/${plan.filter(x => x[2] >= 0.5).length} position(s) of ${sym}`);
  return done > 0;
}

let _scrLast = 0;
async function screenerTick() {
  if (Date.now() - _scrLast < 60_000) return;
  _scrLast = Date.now();
  let P;
  try { P = JSON.parse(fs.readFileSync(CFG.SCREENER_PICKS, "utf8")); }
  catch (e) { return log(`screener: can't read picks (${e.message.slice(0, 60)})`); }
  const ageMin = (Date.now() / 1000 - (P.ts || 0)) / 60;
  if (ageMin > CFG.SCREENER_PICK_MAX_AGE_MIN) return log(`screener: picks are ${ageMin.toFixed(0)} min old — screener down? no opens/exits this pass`);
  const pools = P.pools || {};
  // v0.7.4 clean WATCH: in WATCH but not counting toward EXIT, and still pacing at the entry line
  const cleanWatch = p => !!p && p.tier === "WATCH" && !(p.slowN > 0) && !(p.fadeN > 0)
    && (+p.pace4 || 0) >= (p.aged ? Math.min(CFG.SCREENER_WATCH_MIN_PACE, CFG.SCREENER_WATCH_MIN_PACE_AGED) : CFG.SCREENER_WATCH_MIN_PACE);
  const mine = Object.entries(S.mine).filter(([, m]) => !m.closed && m.target === "SCREENER");

  // ---- exits: fees slowed / LPs leaving / fell out of filters (2 passes in a row)
  const EXIT_TIERS = new Set(["SKIP-too slow", "SKIP-fading", "SKIP-LPs leaving"]);
  for (const [addr, m] of mine) {
    const pk = pools[m.pool];
    let why = null;
    if (pk && EXIT_TIERS.has(pk.tier)) why = `${pk.tier.replace("SKIP-", "")} (pace4h ${pk.pace4}%, mom ${pk.mom})`;
    else if (pk && pk.tier === "GONE" && (pk.gone || 0) >= 2) why = "left the screener filters 2 passes in a row";
    if (why) await closeMine(addr, m, `screener EXIT: ${why}`).catch(e => log(`  [SCRN] close error: ${e.message.slice(0, 80)}`));
  }

  // ---- graceful trim (v0.7.2): WATCH + counting toward EXIT (slow/fading) + pace4h below the keep line.
  //      Once per holding. Pace still >= SCREENER_TRIM_KEEP_PACE = leave it alone.
  if (CFG.SCREENER_TRIM_PCT > 0) {
    const byPoolT = {};
    for (const [addr, m] of Object.entries(S.mine))
      if (!m.closed && m.target === "SCREENER") (byPoolT[m.pool] = byPoolT[m.pool] || []).push([addr, m]);
    for (const [pool, list] of Object.entries(byPoolT)) {
      const pk = pools[pool];
      // v0.7.16 low-pace size-down: an aged pool that slowed below the normal pace line (screener flags
      // lowPace) is cut once to SCREENER_LOWPACE_MULT of its CORE size instead of being exited
      if (pk && pk.lowPace && CFG.SCREENER_LOWPACE_MULT > 0 && (pk.tier === "CORE" || pk.tier === "WATCH")
          && !list.some(([, m]) => m.scrTrimmed || m.scrLowSized)) {
        const poolSol = list.reduce((a, [, m]) => a + (m.solIn || 0), 0);
        let core = CFG.SCREENER_CORE_SOL;
        try { core = await scrSizeFor({ addr: pool, tier: "CORE" }, CFG.SCREENER_CORE_SOL, false, 1); } catch {}
        const target = core * CFG.SCREENER_LOWPACE_MULT, cut = poolSol - target;
        if (cut < Math.max(CFG.SCREENER_TRIM_MIN_SOL, poolSol * 0.1)) { for (const [, m] of list) m.scrLowSized = Date.now(); save(); continue; }
        const why = `aged token, pace4h ${pk.pace4}% below the normal entry line: sizing down to ${Math.round(CFG.SCREENER_LOWPACE_MULT * 100)}% (${poolSol.toFixed(2)} -> ${target.toFixed(2)} SOL)`;
        const ok = await screenerTrim(pool, list, +(100 * cut / poolSol).toFixed(1), why).catch(e => { log(`  [SCRN] low-pace trim error: ${e.message.slice(0, 80)}`); return false; });
        if (ok !== false) { for (const [, m] of list) if (!m.closed) m.scrLowSized = Date.now(); save(); }
        continue;
      }
      if (!pk || pk.tier !== "WATCH") continue;
      if (!((pk.slowN || 0) > 0 || (pk.fadeN || 0) > 0)) continue;           // plain WATCH ("holding"): no trim
      if (!((pk.pace4 ?? 99) < CFG.SCREENER_TRIM_KEEP_PACE)) continue;        // fees still ~3%+: unchanged
      if (list.some(([, m]) => m.scrTrimmed)) continue;                       // already trimmed this holding
      const poolSol = list.reduce((a, [, m]) => a + (m.solIn || 0), 0);
      if (poolSol * CFG.SCREENER_TRIM_PCT / 100 < CFG.SCREENER_TRIM_MIN_SOL) {
        for (const [, m] of list) m.scrTrimmed = Date.now(); save();         // too small to bother; don't re-check
        log(`  [SCRN] ${pk.sym}: trim skipped (${(poolSol * CFG.SCREENER_TRIM_PCT / 100).toFixed(2)} SOL < ${CFG.SCREENER_TRIM_MIN_SOL} min)`);
        continue;
      }
      const why = `${(pk.slowN || 0) > 0 ? `slow ${pk.slowN}` : `fading ${pk.fadeN}`} toward EXIT, pace4h ${pk.pace4}% < ${CFG.SCREENER_TRIM_KEEP_PACE}%, mom ${pk.mom}`;
      await screenerTrim(pool, list, CFG.SCREENER_TRIM_PCT, why).catch(e => log(`  [SCRN] trim error: ${e.message.slice(0, 80)}`));
    }
  }

  // ---- re-center (v0.7.7: per LEG): a leg whose ladder sits entirely BELOW price for SCREENER_RECENTER_H
  // is closed on its own and reopened at the new price (same size + shape). Other legs are untouched.
  if (CFG.SCREENER_RECENTER_H > 0 && Date.now() - (S.scrRcLast || 0) >= 5 * 60_000) {
    S.scrRcLast = Date.now();
    const byPool = {};
    for (const [addr, m] of Object.entries(S.mine))
      if (!m.closed && m.target === "SCREENER") (byPool[m.pool] = byPool[m.pool] || []).push([addr, m]);
    for (const [pool, list] of Object.entries(byPool)) {
      let activeId;
      try { const dl = await getDlmm(pool); await dl.refetchStates(); activeId = dl.lbPair.activeId; } catch { continue; }
      const pk = pools[pool];
      const ignored = CFG.IGNORED_MINTS.includes(list[0][1].mint);          // v0.7.16: blocklisted mint = close only, never reopen
      const eligible = !ignored && pk && (pk.tier === "CORE" || pk.tier === "HOT" || (CFG.SCREENER_WATCH_MULT > 0 && cleanWatch(pk)));
      const sym = list[0][1].scrSym || pool.slice(0, 6);
      let dirty = false;
      const due = [];
      for (const [addr, m] of list) {
        const above = m.maxBin != null && activeId > effTop(addr, m);    // v0.7.10: top of the chunks still open
        if (!above) { if (m.scrAboveSince) { m.scrAboveSince = null; dirty = true; } continue; }
        if (!m.scrAboveSince) { m.scrAboveSince = Date.now(); dirty = true; continue; }
        const hrs = (Date.now() - m.scrAboveSince) / 3600e3;
        if (hrs >= CFG.SCREENER_RECENTER_H) due.push([addr, m, hrs]);
      }
      if (dirty) save();
      if (!due.length) continue;
      const inRange = list.length - due.length;
      // v0.7.10: chunks of one ladder re-center TOGETHER — close them all, reopen once at the combined size
      const byLadder = {};
      for (const [addr, m, hrs] of due) (byLadder[ladderKey(addr, m)] = byLadder[ladderKey(addr, m)] || []).push([addr, m, hrs]);
      for (const grp of Object.values(byLadder)) {
        const [addr, m, hrs] = grp[0];
        let extraSol = 0;
        for (const [a2, m2] of grp.slice(1)) {                            // other chunks of this ladder first
          await closeMine(a2, m2, `screener re-center: ladder above range ${hrs.toFixed(1)}h (chunk)`).catch(e => log(`  [SCRN] close error: ${e.message.slice(0, 80)}`));
          if (m2.closed) extraSol += m2.solIn || 0;                      // only size that actually came back is reopened
        }
        const legSol = +((m.solIn || 0) + extraSol).toFixed(3), shape = m.shape === "Spot" ? "Spot" : "BidAsk";
        log(`  [SCRN] ${sym}: ${shape} leg ${addr.slice(0, 6)}…${grp.length > 1 ? ` (+${grp.length - 1} chunk${grp.length > 2 ? "s" : ""})` : ""} (${legSol} SOL) above its range ${hrs.toFixed(1)}h — ` +
            (eligible ? `RE-CENTERING this leg at the new price (pool still ${pk.plus ? "CORE+" : pk.tier})` : ignored ? `closing (mint is on IGNORED_MINTS)` : `closing (pool no longer CORE/HOT/WATCH)`) +
            (inRange > 0 ? `; ${inRange} other leg(s) still in range, left alone` : ""));
        await closeMine(addr, m, `screener re-center: leg above range ${hrs.toFixed(1)}h`).catch(e => log(`  [SCRN] close error: ${e.message.slice(0, 80)}`));
        if (!m.closed || !eligible || legSol < 0.3) continue;
        if (m.goneOutside) { log(`  [SCRN] ${sym}: leg was closed outside the bot — not reopening it`); continue; }
        if (spikeBlockLeft(pool) > 0) { log(`  [SCRN] ${sym}: pool fee-spiking — not reopening the leg now; the upgrade pass refills it once the spike clears`); continue; }
        if (CFG.DRY_RUN) { log(`  [dry-run] would reopen ${legSol} SOL ${shape}`); continue; }
        try {
          await screenerOpen(pk && { addr: pool, ...pk }, legSol, `RE-CENTER ${shape} leg`, shape);
        } catch (e) { log(`  [SCRN] re-center reopen ${sym} failed: ${(e.message || "").slice(0, 100)} — the upgrade pass will retry sizing`); }
      }
      S.scrTried = S.scrTried || {};
      if (!eligible && !Object.values(S.mine).some(m => !m.closed && m.pool === pool)) S.scrTried[pool] = Date.now();
      save();
    }
  }

  // ---- entries (v0.7.4: WATCH at 33%, tier upgrades add size, 2nd pool per listed-twice token)
  const live = Object.values(S.mine).filter(m => !m.closed && m.target === "SCREENER");
  const heldPools = new Set(live.map(m => m.pool));
  const mintPools = {};
  for (const m of live) (mintPools[m.mint] = mintPools[m.mint] || new Set()).add(m.pool);
  const poolSolOf = pool => live.filter(m => m.pool === pool).reduce((a, m) => a + (m.solIn || 0), 0);
  const mintSolOf = mint => live.filter(m => m.mint === mint).reduce((a, m) => a + (m.solIn || 0), 0);
  const tierLive = pool => (live.find(m => m.pool === pool) || {}).scrTier;
  const plusMult = CFG.SCREENER_PLUS_MULT > 1 ? CFG.SCREENER_PLUS_MULT : 1;
  const plusSpot = CFG.SCREENER_PLUS_SHAPE === "spot";
  const wantWatch = CFG.SCREENER_WATCH_MULT > 0;
  const watchSol = +(CFG.SCREENER_CORE_SOL * CFG.SCREENER_WATCH_MULT).toFixed(3);
  // v0.7.16: CORE slots are weighted by size against the pool's own 1X CORE size (TVL-scaled since v0.7.12),
  // so a 1X CORE = 1 slot however big the pool, and a 2X CORE+ holding = 2 slots of SCREENER_MAX_CORE
  const slotsOf = async (tier, sol, pool) => {
    if (tier !== "CORE") return 0;
    let unit = CFG.SCREENER_CORE_SOL;
    try { if (pool) unit = Math.max(unit, await scrSizeFor({ addr: pool, tier: "CORE" }, CFG.SCREENER_CORE_SOL, false, 1)); } catch {}
    return Math.max(1, Math.round(sol / Math.max(unit, 0.01)));
  };
  let nCore = 0;
  for (const pool of new Set(live.filter(m => m.scrTier === "CORE").map(m => m.pool))) nCore += await slotsOf("CORE", poolSolOf(pool), pool);
  let nHot = new Set(live.filter(m => m.scrTier === "HOT").map(m => m.pool)).size;
  let nWatch = new Set(live.filter(m => m.scrTier === "WATCH").map(m => m.pool)).size;
  S.scrTried = S.scrTried || {};

  // WATCH streak: the screener's streak only counts CORE/HOT, so count clean-WATCH passes ourselves
  S.scrWatchStreak = S.scrWatchStreak || {};
  if (P.ts && P.ts !== S.scrPicksTs) {
    const ws = {};
    for (const [addr, p] of Object.entries(pools)) if (cleanWatch(p)) ws[addr] = (S.scrWatchStreak[addr] || 0) + 1;
    S.scrWatchStreak = ws; S.scrPicksTs = P.ts; save();
  }
  const streakOf = p => p.tier === "WATCH" ? (S.scrWatchStreak[p.addr] || 0) : (p.streak || 0);
  const all = Object.entries(pools).map(([addr, p]) => ({ addr, ...p }));
  const listedPerMint = {};
  for (const p of all) if (p.tier === "CORE" || p.tier === "HOT" || cleanWatch(p)) listedPerMint[p.mint] = (listedPerMint[p.mint] || 0) + 1;
  const ORDER = { CORE: 0, HOT: 1, WATCH: 2 };
  const cands = all
    .filter(p => (p.tier === "CORE" || p.tier === "HOT" || (wantWatch && cleanWatch(p))) && streakOf(p) >= CFG.SCREENER_MIN_STREAK)
    .sort((a, b) => ORDER[a.tier] - ORDER[b.tier] || (b.score || 0) - (a.score || 0));
  let opens = 0;

  // v0.7.3 add-gate. Returns a reason string to HOLD, or null to allow.
  const topupGate = (p, mineHere) => {
    if ((+p.mom || 0) < CFG.SCREENER_PLUS_MIN_MOM) return `mom ${p.mom} < ${CFG.SCREENER_PLUS_MIN_MOM}`;
    if (CFG.SCREENER_TOPUP_PACE_CHECK) {
      const p0s = mineHere.map(m => m.scrPace0).filter(v => v != null && Number.isFinite(+v));
      if (p0s.length) {
        const p0 = Math.max(...p0s.map(Number));
        if (!(+p.pace4 >= p0)) return `pace4h ${p.pace4}% < ${p0}% at open (slowing)`;
      }
    }
    return null;
  };
  const balOk = async need => {
    if (!signer || CFG.DRY_RUN) return true;
    const bal = (await conn.getBalance(signer.publicKey)) / LAMPORTS_PER_SOL;
    return bal - CFG.SOL_RESERVE - CFG.SCREENER_RESERVE_SOL >= need;
  };
  // size a pool should have for its CURRENT tier (held pools only ever grow toward this)
  const targetOf = p => p.tier === "CORE" ? CFG.SCREENER_CORE_SOL * (p.plus && plusMult > 1 && CFG.SCREENER_PLUS_TOPUP ? plusMult : 1)
                      : p.tier === "HOT" ? CFG.SCREENER_HOT_SOL : watchSol;

  // ---- upgrades: a held pool whose tier now warrants more size (WATCH->HOT/CORE, HOT->CORE, CORE->CORE+)
  for (const p of cands) {
    if (opens >= CFG.SCREENER_OPENS_PER_PASS) break;
    if (!heldPools.has(p.addr) || p.tier === "WATCH") continue;
    if (CFG.IGNORED_MINTS.includes(p.mint)) continue;
    const mineHere = live.filter(m => m.pool === p.addr);
    if (spikeBlockLeft(p.addr) > 0) continue;                                // fee spike: no size added while hot
    if (CFG.SPIKE_REFILL_H > 0 && mineHere.some(m => m.spikeTrimmed && Date.now() - m.spikeTrimmed < CFG.SPIKE_REFILL_H * 3600e3)) continue; // spike-trimmed: don't buy it back yet
    const plusOn = p.tier === "CORE" && p.plus && plusMult > 1 && CFG.SCREENER_PLUS_TOPUP;
    const have = poolSolOf(p.addr);
    let want = await scrSizeFor(p, targetOf(p), plusOn, plusMult);            // v0.7.12 TVL-aware
    if (p.lowPace && p.tier === "CORE" && CFG.SCREENER_LOWPACE_MULT > 0) want = +(want * CFG.SCREENER_LOWPACE_MULT).toFixed(2);   // v0.7.16 aged low-pace: half size
    const core1x = plusOn ? want / plusMult : want;                           // the 1X (BidAsk/base) part
    if (want - have < Math.max(0.3, want * 0.1)) continue;                   // already at (or above) size
    if (Date.now() - (S.scrTried["topup:" + p.addr] || 0) < 60 * 60_000) continue;
    const fromTier = tierLive(p.addr) || "?", label = p.plus ? "CORE+" : p.tier;
    const gate = topupGate(p, mineHere);
    if (gate) { S.scrTried["topup:" + p.addr] = Date.now(); save(); log(`  [SCRN] ${p.sym} ${fromTier} -> ${label}: add held (${gate})`); continue; }
    const slotsNow = mineHere.some(m => m.scrTier === "CORE") ? await slotsOf("CORE", have, p.addr) : 0;
    const slotsAfter = await slotsOf(p.tier, want, p.addr);
    if (p.tier === "CORE" && nCore - slotsNow + slotsAfter > CFG.SCREENER_MAX_CORE) { log(`  [SCRN] ${p.sym} ${fromTier} -> ${label}: add would exceed ${CFG.SCREENER_MAX_CORE} CORE slots — holding at ${have.toFixed(2)} SOL`); continue; }
    if (p.tier === "HOT" && fromTier !== "HOT" && nHot >= CFG.SCREENER_MAX_HOT) continue;
    if (CFG.SCREENER_MAX_SOL_PER_MINT > 0 && mintSolOf(p.mint) + (want - have) > CFG.SCREENER_MAX_SOL_PER_MINT + 1e-6) {
      log(`  [SCRN] ${p.sym} ${fromTier} -> ${label}: add would pass the ${CFG.SCREENER_MAX_SOL_PER_MINT} SOL per-token cap — holding`); continue;
    }
    // legs: BidAsk up to 1X CORE (or the HOT size); in spot mode the CORE+ extra above 1X goes in as Spot
    const legSol = sh => mineHere.filter(m => (m.shape === "Spot") === (sh === "Spot")).reduce((a, m) => a + (m.solIn || 0), 0);
    const baseWant = p.tier === "CORE" && plusSpot ? Math.min(want, core1x) : want;
    const spotWant = p.tier === "CORE" && plusSpot ? Math.max(0, want - core1x) : 0;
    const legs = [];
    if (scrTierShape(p.tier) === "spot") {                    // v0.7.9: everything is Spot — one bucket (v0.7.17: per tier)
      const add = +(want - have).toFixed(3); if (add >= 0.3) legs.push(["Spot", add]);
    } else {
      const bAdd = +(baseWant - legSol("BidAsk")).toFixed(3); if (bAdd >= 0.3) legs.push(["BidAsk", bAdd]);
      const sAdd = +(spotWant - legSol("Spot")).toFixed(3);   if (sAdd >= 0.3) legs.push(["Spot", sAdd]);
    }
    if (!legs.length) continue;
    S.scrTried["topup:" + p.addr] = Date.now(); save();
    let added = 0;
    for (const [shape, amt] of legs) {
      if (!(await balOk(amt))) { log(`  [SCRN] ${p.sym} ${fromTier} -> ${label}: +${amt} SOL would breach the reserve — waiting`); break; }
      try {
        await screenerOpen(p, amt, `UPGRADE ${fromTier}->${label} +${amt} SOL (${have.toFixed(2)} -> ${want.toFixed(2)})${shape === "Spot" ? " as Spot leg" : ""}`, shape);
        added += amt; opens++;
      } catch (e) { log(`  [SCRN] upgrade ${p.sym} failed: ${(e.message || "").slice(0, 100)}`); break; }
    }
    if (added > 0) {
      for (const m of Object.values(S.mine)) if (!m.closed && m.target === "SCREENER" && m.pool === p.addr) { m.scrTier = p.tier; m.scrTrimmed = null; if (!p.lowPace) m.scrLowSized = null; }  // re-arm the trims
      if (fromTier === "WATCH") nWatch--;
      if (fromTier === "HOT" && p.tier !== "HOT") nHot--;
      if (p.tier === "HOT" && fromTier !== "HOT") nHot++;
      nCore += (await slotsOf(p.tier, have + added, p.addr)) - slotsNow;
      save();
    }
  }

  // ---- new pools
  let balLogged = false;
  const waiting = [];                                                          // v0.7.16: qualified but blocked by a cap
  for (const p of cands) {
    if (opens >= CFG.SCREENER_OPENS_PER_PASS) break;
    if (heldPools.has(p.addr)) continue;
    if (CFG.IGNORED_MINTS.includes(p.mint)) continue;                        // your manual blocklist (story risk etc.)
    const poolsOfMint = mintPools[p.mint] ? mintPools[p.mint].size : 0;
    if (poolsOfMint >= 1) {                                                   // v0.7.4: 2nd pool per token
      if (poolsOfMint >= CFG.SCREENER_MAX_POOLS_PER_MINT) continue;
      if ((listedPerMint[p.mint] || 0) < 2) continue;                        // only while the token is listed twice+
    }
    if (Date.now() - (S.scrTried[p.addr] || 0) < 60 * 60_000) { waiting.push(`${p.sym}(${p.tier}: retry wait ${Math.ceil((60 * 60_000 - (Date.now() - S.scrTried[p.addr])) / 60_000)}m)`); continue; }
    if (spikeBlockLeft(p.addr) > 0) { waiting.push(`${p.sym}(${p.tier}: fee spike)`); continue; }
    const isPlus = p.tier === "CORE" && p.plus && plusMult > 1;
    const slots = isPlus ? Math.round(plusMult) : 1;
    if (p.tier === "CORE" && nCore + slots > CFG.SCREENER_MAX_CORE) {
      if (!(isPlus && nCore + 1 <= CFG.SCREENER_MAX_CORE)) { waiting.push(`${p.sym}(CORE: slots ${nCore}/${CFG.SCREENER_MAX_CORE} full)`); continue; }
    }
    if (p.tier === "HOT" && nHot >= CFG.SCREENER_MAX_HOT) { waiting.push(`${p.sym}(HOT: slots ${nHot}/${CFG.SCREENER_MAX_HOT} full)`); continue; }
    if (p.tier === "WATCH" && nWatch >= CFG.SCREENER_MAX_WATCH) { waiting.push(`${p.sym}(WATCH: slots ${nWatch}/${CFG.SCREENER_MAX_WATCH} full)`); continue; }
    // CORE+ opens at full size in BidAsk mode; in spot mode it opens 1X BidAsk and the upgrade pass adds the Spot leg
    const fullPlus = isPlus && !plusSpot && nCore + slots <= CFG.SCREENER_MAX_CORE;
    const sol0 = p.tier === "HOT" ? CFG.SCREENER_HOT_SOL : p.tier === "WATCH" ? watchSol : CFG.SCREENER_CORE_SOL * (fullPlus ? plusMult : 1);
    let sol = await scrSizeFor(p, sol0, fullPlus, plusMult);                  // v0.7.12 TVL-scaled CORE + TVL ceiling
    const lowOpen = p.lowPace && p.tier === "CORE" && CFG.SCREENER_LOWPACE_MULT > 0;
    if (lowOpen) { sol = +(sol * CFG.SCREENER_LOWPACE_MULT).toFixed(2); log(`  [SCRN] ${p.sym}: aged token at ${p.pace4}% (below the normal line) — opening at ${Math.round(CFG.SCREENER_LOWPACE_MULT * 100)}% size, ${sol} SOL`); }
    if (sol < 0.5) { S.scrTried[p.addr] = Date.now(); save(); log(`  [SCRN] skip ${p.sym}: ${CFG.SCREENER_MAX_TVL_PCT}% of pool TVL is only ${sol} SOL`); continue; }
    if (Math.abs(sol - sol0) > 0.05) log(`  [SCRN] ${p.sym} ${p.tier}: size ${sol0} -> ${sol} SOL (pool TVL sizing)`);
    if (CFG.SCREENER_MAX_SOL_PER_MINT > 0 && mintSolOf(p.mint) + sol > CFG.SCREENER_MAX_SOL_PER_MINT + 1e-6) { waiting.push(`${p.sym}(${p.tier}: per-token cap ${CFG.SCREENER_MAX_SOL_PER_MINT} SOL)`); continue; }
    const tax = await tokenTaxBps(p.mint).catch(() => null);
    if (tax == null || tax > CFG.SCREENER_MAX_TAX_BPS) { S.scrTried[p.addr] = Date.now(); save(); log(`  [SCRN] skip ${p.sym}: transfer tax ${tax == null ? "unknown" : (tax / 100) + "%"}`); continue; }
    if (!(await balOk(sol))) {
      if (!balLogged) log(`  [SCRN] ${p.sym} (${p.tier}) qualifies but ${sol} SOL would breach the ${CFG.SCREENER_RESERVE_SOL} SOL reserve — waiting`);
      balLogged = true; continue;                                             // a smaller WATCH open may still fit
    }
    S.scrTried[p.addr] = Date.now(); save();
    try {
      await screenerOpen(p, sol, poolsOfMint ? "OPEN 2nd pool" : "OPEN");
      opens++; heldPools.add(p.addr);
      if (p.lowPace) for (const m of Object.values(S.mine)) if (!m.closed && m.target === "SCREENER" && m.pool === p.addr) m.scrLowSized = Date.now();
      (mintPools[p.mint] = mintPools[p.mint] || new Set()).add(p.addr);
      live.push(...Object.values(S.mine).filter(m => !m.closed && m.target === "SCREENER" && m.pool === p.addr && !live.includes(m)));
      if (p.tier === "CORE") nCore += fullPlus ? slots : 1; else if (p.tier === "HOT") nHot++; else nWatch++;
    } catch (e) { log(`  [SCRN] open ${p.sym} failed: ${(e.message || "").slice(0, 100)}`); }
  }
  const wKey = waiting.map(w => w.replace(/ \d+m\)/, ")")).join("|");
  if (wKey !== S._scrWaitKey) {
    S._scrWaitKey = wKey;
    if (waiting.length) log(`  [SCRN] waiting: ${waiting.join(", ")} | CORE ${nCore}/${CFG.SCREENER_MAX_CORE} HOT ${nHot}/${CFG.SCREENER_MAX_HOT} WATCH ${nWatch}/${CFG.SCREENER_MAX_WATCH}`);
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
  if (bal === 0n) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const u = `${CFG.JUP}/ultra/v1/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${bal}&taker=${signer.publicKey.toBase58()}`;
    const r = await jfetch(u).then(x => x.json()).catch(() => ({}));
    if (!r.transaction) return log("  sell: no route", JSON.stringify(r).slice(0, 100));
    if (+r.outAmount < 2_000_000) // < 0.002 SOL out: dust, a swap tx costs more than it returns
      return log(`  sell: skipping dust (${(+r.outAmount / 1e9).toFixed(6)} SOL out) — not worth a transaction`);
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
      return;
    }
    log(`  sell attempt ${attempt}/2 failed: ${JSON.stringify(res).slice(0, 100)}`);
    await new Promise(s => setTimeout(s, 2000));
  }
  log("  sell: giving up — tokens remain in wallet, will be swept with the next close on this mint");
}


const WSOL = SOL_MINT;
// janitor: hourly sweep of WALLET balances on every mint the bot has ever traded.
// Wallet balance is exit residue or claimed fees by definition — position liquidity lives in
// position accounts, never the wallet — so sweeping is always safe, open positions or not.
// Catches rpc-lag misses, partial fills, gave-up sells, and accumulated sub-floor dust.
let lastJanitor = 0;
async function walletJanitor() {
  if (Date.now() - lastJanitor < CFG.JANITOR_MIN * 60_000) return;
  lastJanitor = Date.now();
  const openMints = new Set(Object.values(S.mine).filter(m => !m.closed).map(m => m.mint));
  const touched   = new Set(Object.values(S.mine).map(m => m.mint));
  for (const mint of touched) {
    if (mint === SOL_MINT) continue;
    try {
      const r = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) });
      let bal = 0n; const empties = [];
      for (const a of r.value) {
        const amt = BigInt(a.account.data.parsed.info.tokenAmount.amount);
        if (amt === 0n) empties.push(a.pubkey); else bal += amt;
      }
      if (bal > 0n) { log(`  janitor: leftover ${mint.slice(0, 6)}… in wallet — sweeping`); await ledgerRun({ mint }, () => ultraSellAll(mint)); }
      else if (!openMints.has(mint)) for (const pk of empties) { // reclaim ATA rent on fully-retired mints only
        const { createCloseAccountInstruction } = require("@solana/spl-token");
        const tx = new Transaction().add(createCloseAccountInstruction(pk, signer.publicKey, signer.publicKey));
        await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" }).catch(() => {});
      }
    } catch {}
  }
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
  return ledgerRun({ pool: m.pool, mint: m.mint, sym: m.scrSym }, () => claimFeesImpl(addr, m, minSol));
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
  return ledgerRun({ pool: m.pool, mint: m.mint, sym: m.scrSym }, async () => {
    const r = await closeMineImpl(addr, m, reason, opts);
    if (m.closed) ledgerEndIfFlat(m.pool);
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
      if (acct === null) { p = null; m.goneOutside = true; log(`  position ${addr.slice(0, 8)}… was already closed outside the bot (manual close?) — booking it closed`); }   // chain says: account truly gone
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
      st.netPnlSol += (m.solIn || 0) * (+m.lastPnl) / 100;
      st.recent.push(+(+m.lastPnl).toFixed(2)); if (st.recent.length > 20) st.recent.shift();
      scrShapeStat(m, (m.solIn || 0) * (+m.lastPnl) / 100, true);
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
// ---- ladder chunks (v0.7.10) ----------------------------------------------------------------
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
// bin-array guard: returns the (possibly raised) minBin, or throws to skip the open
async function binArrayGuard(dlmm, minBin, maxBin, step, sym) {
  const lbPair = dlmm.pubkey || dlmm.lbPair?.publicKey || null;
  const programId = dlmm.program?.programId;
  if (!lbPair || !programId) throw new Error(`skip: bin-array check has no pool/program id — not risking non-refundable rent`);
  const idxOf = b => Math.floor(b / 70);
  const pda = i => {
    if (typeof DLMMPkg.deriveBinArray === "function") return DLMMPkg.deriveBinArray(lbPair, new BN(i), programId)[0];
    const buf = Buffer.alloc(8); buf.writeBigInt64LE(BigInt(i));
    return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), buf], programId)[0];
  };
  const activeIdx = idxOf(dlmm.lbPair.activeId), top = idxOf(maxBin), bot = idxOf(minBin);
  const idxs = []; for (let i = top; i >= bot; i--) idxs.push(i);
  const all = [activeIdx, ...idxs];
  const infos = [];
  for (let i = 0; i < all.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(all.slice(i, i + 100).map(pda)));
  if (!infos[0]) throw new Error(`skip: bin-array check couldn't verify the active bin array (derivation mismatch) — not risking non-refundable rent`);
  const exists = infos.slice(1).map(x => !!x);
  const missing = exists.filter(x => !x).length;
  if (missing === 0 || missing <= CFG.SCREENER_MAX_NEW_BIN_ARRAYS) {
    if (!missing) log(`  [SCRN] ${sym}: bin arrays — all ${exists.length} already exist, no new rent`);
    if (missing) log(`  [SCRN] ${sym}: will create ${missing} new bin array(s) (~${(missing * BINARRAY_RENT_SOL).toFixed(3)} SOL non-refundable, allowed by SCREENER_MAX_NEW_BIN_ARRAYS)`);
    return minBin;
  }
  let k = 0; while (k < exists.length && exists[k]) k++;                // contiguous existing arrays from the top down
  if (k === 0) throw new Error(`skip: top of the ladder needs a new bin array (~${BINARRAY_RENT_SOL} SOL non-refundable)`);
  const newMin = Math.max(minBin, idxs[k - 1] * 70);
  const bins = maxBin - newMin + 1, depth = 100 * (1 - Math.pow(1 + step / 10000, -bins));
  if (depth < CFG.SCREENER_MIN_DEPTH_PCT) throw new Error(`skip: only ${depth.toFixed(0)}% of depth has existing bin arrays (< ${CFG.SCREENER_MIN_DEPTH_PCT}%) — ${missing} new ones would cost ~${(missing * BINARRAY_RENT_SOL).toFixed(3)} SOL`);
  log(`  [SCRN] ${sym}: ladder cut to existing bin arrays — ${minBin}..${maxBin} -> ${newMin}..${maxBin} (${depth.toFixed(0)}% deep), avoided ${missing} new array(s) ~${(missing * BINARRAY_RENT_SOL).toFixed(3)} SOL`);
  return newMin;
}
async function chainPnl(dl, addr, m, activeId = null) {
  const p = await dl.getPosition(new PublicKey(addr));
  // price from binId is pure math — only fetch when no fresh activeId was handed in
  const price = activeId != null
    ? parseFloat(getPriceOfBinByBinId(activeId, dl.lbPair.binStep).toString())
    : parseFloat((await dl.getActiveBin()).price || "0");
  const d = p.positionData;
  const val = (Number(d.totalXAmount) * price + Number(d.totalYAmount)) / LAMPORTS_PER_SOL;
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
  m.lastValSol = val + fees; m.lastValAt = now;   // v0.7.10: for whole-ladder pnl across chunks
  return ((val + fees) / m.solIn - 1) * 100;
}
// ---- fee-spike de-risk (0.7.8) --------------------------------------------------------------
// a reading only counts when measured over >= SPIKE_MIN_WINDOW_MIN; the spike state goes stale
// if not re-confirmed within 3 check intervals (min 15m), so one old reading can't act forever
function noteSpikeReading(m, rate, now = Date.now()) {
  m.spikeRate = +(+rate).toFixed(3); m.spikeRateAt = now;
  if (CFG.SPIKE_FEE_30M_PCT > 0 && rate >= CFG.SPIKE_FEE_30M_PCT && m.pool) {
    const prev = S.spikePools[m.pool];
    if (!prev || prev.until < now) log(`  [spike] ${m.scrSym || m.pool.slice(0, 6)}: fees ${rate.toFixed(2)}%/30m — new opens/adds on this pool blocked while it stays hot`);
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
// staged response for a SPIKING position; returns "closed" when the position was exited
async function spikeManage(addr, m, pnl) {
  const tag = m.target === "SCREENER" ? "SCRN" : (m.target || "orphan").slice(0, 6);
  const why = `fees ${(+m.spikeRate).toFixed(2)}%/30m, pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`;
  if (pnl <= CFG.SPIKE_EXIT_PNL) {
    await closeMine(addr, m, `fee-spike exit: ${why} <= ${CFG.SPIKE_EXIT_PNL}%`);
    return m.closed ? "closed" : null;
  }
  // stage 1 (always while spiking): lock fees, at most once per block window
  if (Date.now() - (m.spikeClaimAt || 0) >= CFG.SPIKE_BLOCK_MIN * 60_000) {
    m.spikeClaimAt = Date.now(); save();
    log(`  [${tag}] spike on ${m.scrSym || ""} ${addr.slice(0, 8)}… (${why}) — claiming fees`);
    await claimFees(addr, m, CFG.SPIKE_CLAIM_MIN_SOL);
  }
  // stage 2: price already moving into the ladder -> cut this position once (normal trim path:
  // wallet-truth ledger, tracker ledger, sell, basis/fee-baseline rescale)
  if (CFG.SPIKE_TRIM_PCT > 0 && CFG.SPIKE_TRIM_PCT < 100 && !m.spikeTrimmed && !m.closed
      && pnl <= CFG.SPIKE_TRIM_PNL && m.solIn >= CFG.SPIKE_TRIM_MIN_SOL) {
    const ok = await screenerTrim(m.pool, [[addr, m]], CFG.SPIKE_TRIM_PCT, `fee-spike trim: ${why} <= ${CFG.SPIKE_TRIM_PNL}%`)
      .catch(e => { log(`  [${tag}] spike trim error: ${(e.message || "").slice(0, 80)}`); return false; });
    if (ok) { m.spikeTrimmed = Date.now(); save(); }
  }
  return null;
}
// stop decision, fee-velocity aware. A HOT position (earning >= HOT_FEE_30M_PCT of deposit
// per 30min) has the fee engine actively paying for its drawdown: it gets the deeper
// STOP_LOSS_HOT_PCT line and keeps wick-confirmation patience even below range. A COLD
// position gets the tight line, and out-of-range cold breaches close immediately — which is
// what a rug looks like: price out the bottom AND the fee printer stopped. The hard collapse
// line closes instantly everywhere, hot or not — that is the massive-selloff cap.
function slShouldClose(m, pnl, inRange) {
  const o = slCfgFor(m.target);
  // hard collapse line: instant, unconditional, independent of the soft stop (which may be off)
  if (o.hard > 0 && pnl <= -o.hard) return true;
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
      const lpG = ladderPnl(addr, m, pnl); pnl = lpG.pnl;                 // v0.7.10: whole-ladder pnl for chunks
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
    await ultraSellAll(mint).catch(e => log(`  burst sell error: ${e.message.slice(0, 80)}`));
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
  if (CFG.SCREENER_PICKS) await screenerTick().catch(e => log(`screener tick error: ${e.message}`));

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
          below = ap.activeId < m.minBin; above = ap.activeId > effTop(addr, m); inRange = !below && !above; // v0.7.10: chunk-aware top
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

        const lp = (pnl != null && Number.isFinite(+pnl)) ? ladderPnl(addr, m, +pnl) : null;   // v0.7.10: whole-ladder pnl for chunks
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
  if (process.argv.includes("--version")) { console.log(`${BOT_NAME} v${BOT_VERSION}`); process.exit(0); }
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
  log(`${BOT_NAME} v${BOT_VERSION} up | ${TARGETS.length} target(s): ${TARGET_CFG.map(t => t.addr.slice(0, 6)
    + (t.fixedSol ? ":fixed=" + t.fixedSol : t.maxSol ? ":max=" + t.maxSol : "")
    + (t.pct != null ? ":pct=" + t.pct : "")
    + (t.lowMcapSol != null ? ":lowmcap=" + t.lowMcapSol : "")
    + (t.minDep != null ? ":min=" + t.minDep : "")).join(", ")}`);
  log(`mode=${CFG.COPY_MODE} (${CFG.COPY_MODE === "ratio" ? CFG.COPY_RATIO_PCT + "%" : CFG.COPY_FIXED_SOL + " SOL"}, cap ${CFG.MAX_COPY_SOL} SOL) | ` +
      `min their deposit ${CFG.MIN_TARGET_DEPOSIT_SOL} SOL | caps ${CFG.MAX_POS_PER_WALLET}/wallet ${CFG.MAX_GLOBAL_POSITIONS} global`);
  log(`gates: jup>=${CFG.MIN_JUP_SCORE} mcap>=$${CFG.MIN_MCAP_USD / 1e6}M age>=${CFG.MIN_TOKEN_AGE_H}h width>=${CFG.MIN_WIDTH_PCT}%/${CFG.MIN_WIDTH_LOWCAP_PCT}%(<$${CFG.MIN_WIDTH_MCAP_USD / 1e6}M) | ` +
      `exits: mirror close / SL -${CFG.STOP_LOSS_PCT}% (per-target sl=/hot=/hard=/follow= overrides apply) / OOR ${CFG.AUTO_CLOSE_OOR_MIN}min / OOR-up ${CFG.AUTO_CLOSE_OOR_UP_MIN}min (follow-pierce ${CFG.FOLLOW_OOR_UP_MIN || "off"}${CFG.FOLLOW_OOR_UP_MIN ? "min" : ""}, per-target oorup= overrides) | DRY_RUN=${CFG.DRY_RUN}`);
  if (CFG.SCREENER_PICKS) log(`screener sizing: CORE ${CFG.SCREENER_CORE_SOL} SOL, CORE+ x${CFG.SCREENER_PLUS_MULT} (top-ups ${CFG.SCREENER_PLUS_TOPUP ? "on" : "off"}), HOT ${CFG.SCREENER_HOT_SOL} SOL | trim ${CFG.SCREENER_TRIM_PCT}% when slow/fading toward EXIT and pace4h < ${CFG.SCREENER_TRIM_KEEP_PACE}%`);
  if (CFG.SCREENER_PICKS) log(`screener WATCH: ${CFG.SCREENER_WATCH_MULT > 0 ? `opens at ${CFG.SCREENER_WATCH_MULT}x CORE (${+(CFG.SCREENER_CORE_SOL * CFG.SCREENER_WATCH_MULT).toFixed(2)} SOL), max ${CFG.SCREENER_MAX_WATCH}, clean WATCH pace4h >= ${CFG.SCREENER_WATCH_MIN_PACE}%` : "off"} | pools per token: ${CFG.SCREENER_MAX_POOLS_PER_MINT} (2nd only when listed twice)${CFG.SCREENER_MAX_SOL_PER_MINT > 0 ? `, cap ${CFG.SCREENER_MAX_SOL_PER_MINT} SOL/token` : ""} | upgrades: WATCH->HOT->CORE->CORE+ add size`);
  if (CFG.SCREENER_PICKS) log(`screener BASE legs: ${CFG.SCREENER_BASE_SHAPE === "spot" ? `SPOT ${CFG.SCREENER_BASE_SPOT_DEPTH}% deep (A/B vs BidAsk)` : `BidAsk ${CFG.SCREENER_DEPTH}% deep`}`);
  if (CFG.SCREENER_PICKS && (scrTierDepth("CORE") || scrTierDepth("HOT") || scrTierDepth("WATCH")))
    log(`screener per-tier depth (all bin steps): CORE/CORE+ ${scrTierDepth("CORE") || "default"}% | HOT ${scrTierDepth("HOT") || "default"}% | WATCH ${scrTierDepth("WATCH") || "default"}%`);
  if (CFG.SCREENER_PICKS && CFG.SCREENER_HOT_MIN_AGE_H > 0) log(`screener HOT min token age: ${CFG.SCREENER_HOT_MIN_AGE_H}h`);
  if (CFG.SCREENER_PICKS) log(`screener per-tier shape: CORE ${scrTierShape("CORE")} | HOT ${scrTierShape("HOT")} | WATCH ${scrTierShape("WATCH")}`);
  log(`ignored mints (never opened): ${CFG.IGNORED_MINTS.length ? CFG.IGNORED_MINTS.map(m => m.slice(0, 6) + "…").join(", ") : "none"}`);
  if (CFG.SCREENER_PICKS) log(`screener min bin step: ${CFG.SCREENER_MIN_BIN_STEP > 0 ? CFG.SCREENER_MIN_BIN_STEP + " (smaller-step pools never opened)" : "off"}`);
  if (CFG.SCREENER_PICKS) log(`screener TVL sizing: ${CFG.SCREENER_CORE_TVL_PCT > 0 ? `CORE = max(${CFG.SCREENER_CORE_SOL}, ${CFG.SCREENER_CORE_TVL_PCT}% of pool TVL) capped ${CFG.SCREENER_CORE_MAX_SOL} SOL (x${CFG.SCREENER_PLUS_MULT} CORE+)` : "off (fixed tier sizes)"} | ceiling ${CFG.SCREENER_MAX_TVL_PCT > 0 ? CFG.SCREENER_MAX_TVL_PCT + "% of pool TVL, all tiers" : "off"} | per-token cap ${CFG.SCREENER_MAX_SOL_PER_MINT > 0 ? CFG.SCREENER_MAX_SOL_PER_MINT + " SOL" : "off"}`);
  if (CFG.SCREENER_PICKS) log(`screener CORE+ extra: ${CFG.SCREENER_PLUS_SHAPE === "spot" ? `Spot leg ${CFG.SCREENER_PLUS_SPOT_DEPTH}% deep` : "BidAsk"} | top-up gate: mom >= ${CFG.SCREENER_PLUS_MIN_MOM}${CFG.SCREENER_TOPUP_PACE_CHECK ? ", pace4h >= pace at open" : ""}` + (scrShapeSummary() ? ` | legs: ${scrShapeSummary()}` : ""));
  log(`fee-spike de-risk: ${CFG.SPIKE_FEE_30M_PCT > 0 ? `ON at ${CFG.SPIKE_FEE_30M_PCT}%/30m — claim + block pool; trim ${CFG.SPIKE_TRIM_PCT}% at pnl <= ${CFG.SPIKE_TRIM_PNL}%; exit at pnl <= ${CFG.SPIKE_EXIT_PNL}%; re-check every ${CFG.SPIKE_CHECK_MIN}m; no refill ${CFG.SPIKE_REFILL_H}h` : "off (SPIKE_FEE_30M_PCT=0)"}`);
  if (signer) log("signer:", signer.publicKey.toBase58());
  if (CFG.SCREENER_PICKS) log(`screener re-center: ${CFG.SCREENER_RECENTER_H > 0 ? `after ${CFG.SCREENER_RECENTER_H}h above range (whole ladder)` : "OFF (SCREENER_RECENTER_H=0)"} | bin-array guard: ${CFG.SCREENER_MAX_NEW_BIN_ARRAYS > 0 ? `allow up to ${CFG.SCREENER_MAX_NEW_BIN_ARRAYS} new per open` : "never create new bin arrays"} (min depth ${CFG.SCREENER_MIN_DEPTH_PCT}%)`);
  if (signer) await repairChunkGroups().catch(e => log(`chunk repair error: ${(e.message || "").slice(0, 80)}`));
  log(`wallet-truth ledger: on${ledgerTotalsLine() ? " | " + ledgerTotalsLine() : " | no closed holdings measured yet"}`);
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
