# botplatform — notes for Claude

Ian's unified bot platform. Target: **Windows VPS**, Node 22.13+ (uses built-in `node:sqlite`), run as a
Windows service via NSSM. Ian wants finished, ready-to-run files and simple step-by-step instructions —
not snippets to assemble. Dry-run first, always.

## Layout
- `bp.js` — CLI (same powers as the portal, plus user management).
- `portal/` — the web UI (index.html, app.js, style.css). All text goes through textContent.
- `engine/` — `db.js` (SQLite schema), `keystore.js` (AES-GCM secrets, `BP_MASTER_KEY`), `supervisor.js`
  (worker lifecycle, wallet ownership, backoff, heartbeat, settings-change restart), `worker-host.js`
  (loads a bot as the main module inside a worker thread), `limiter.js` (SharedArrayBuffer token bucket
  wrapping `fetch`), `strategies.js` (strategy registry: script, required settings, env building),
  `tracker.js` (positions + entry levers + outcome), `logs.js` (ring buffer, daily files, decision
  classifier), `engine.js` (service runtime).
- `legacy/` — the bots as they ran in production. **Do not edit**, except these documented patches:
  - `screener.js`: `const DIR = process.env.BOT_DATA_DIR || __dirname;`
  Versions: copylp 0.6.23 (from `bots/vahalla`), screenerlp 0.7.18 (from `bots2/screenerlp`; screenerlp2
  is the same file with `SCREENER_BASE_SHAPE=spot`), screener (bots2), swapcopy 1.2 (bots2).
- `test/` — `node:test`; run `npm test`. Every behaviour change needs a test.

## Rules
- Never commit secrets, `.env` files, keys, state or the `data/` folder.
- Dry-run must never receive `PRIVATE_KEY` (enforced in `strategies.buildEnv`).
- One live worker per wallet (enforced in `supervisor.start`). Don't weaken it.
- Settings vs secrets: anything matching `isSecretKey` goes through the keystore, never the settings table.
- Legacy bots read config from env at boot, so a settings change = worker restart (supervisor does it).
- Ian's decisions (Oct 2026): josh and matt run copylp 0.6.23 behaviour; screener picks inform exits only on
  screener-LP positions (leave copylp's `SCREENER_GATE` off); Josh/Matt see only their own instances and PnL.

## Roadmap
1. ✅ Phase 1a: engine + supervisor + keystore + limiter + tracker + CLI around the unchanged bots.
2. Phase 1b: merge copylp/screenerlp into one LP core (60 shared functions), replay tests per behaviour.
3. ✅ Portal: `engine/portal.js` + `engine/auth.js` + `portal/` (plain JS, CSP, no build). 127.0.0.1 only,
   reached via `tailscale serve`; password login (Ian chose no 2FA by default; `--2fa` per user is optional); admin vs operator (owner == user name); X-BP header on writes.
4. Later: EVM workers (hoodlp, hoodscreenerlp); token-narrative ratings by Claude, paper-only until +EV.
