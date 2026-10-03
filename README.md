# botplatform

One engine for the Solana bots — copy-LP, screener-LP, the screener and swapcopy — running as
supervised workers inside a single Windows service, with encrypted secrets, a shared rate limiter,
position tracking with entry "levers", and (next) a web portal.

Phase 1 runs the proven bots **unchanged** (`legacy/`): copylp 0.6.23, screenerlp 0.7.18 (both shapes
via `SCREENER_BASE_SHAPE`), screener, swapcopy 1.2. Phase 1b merges copylp and screenerlp into one LP
core behind the same interface.

## How it works

- Each **instance** (a bot + its wallet + its settings) is a row in a SQLite database.
- The **supervisor** starts one worker thread per enabled instance. Stopping a worker ends it
  completely — there is no separate process left to become a ghost.
- **One live worker per wallet**: a second live instance on the same wallet is refused.
- **Dry-run never receives the private key.**
- A **crashed** worker restarts with backoff (5s → 5min); a **hung** one (no heartbeat 150s) is killed
  and restarted; a **settings change** restarts that worker within ~5s.
- **Secrets** (keys, API keys, RPC URLs, webhooks) are AES-256-GCM encrypted with a master key that
  only lives in the `BP_MASTER_KEY` environment variable.
- **Rate limiter**: every bot's calls to Meteora's datapi share one budget (default 20/s; the IP limit
  is 30/s). Solana RPC traffic is not routed through it.
- **Tracker**: every minute it records each LP position and, the first time it sees one, snapshots the
  levers: TVL, market cap, 24h volume, token age, pool age, fee pace 30m/1h/4h/24h, bin step, base fee,
  shape, range width and the stop-loss settings (including the target's per-wallet overrides). On close
  it records last/peak PnL and the close reason. `bp levers` groups results by each lever.
- **Decisions**: every open/add/close/trim/skip/swap/error line a bot logs is stored, tagged dry or
  live, so a dry-run can be compared with the old live bot over the same hours.

## Install on Windows

1. Install Node.js LTS (22.13+ or 24) from https://nodejs.org.
2. `git clone https://github.com/ianbartosh/botplatform C:\botplatform`
3. PowerShell **as Administrator**:
   ```
   cd C:\botplatform
   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -DatapiLimit 5
   ```
   Add `-Service` to install it as a Windows service (starts on boot, restarts on crash).
   On a box that still runs the old bots, keep `-DatapiLimit 5` so the live bots keep their datapi headroom.
4. Open a **new** PowerShell window — `bp help` now works anywhere.

## Dry-run on the current VPS

```
powershell -ExecutionPolicy Bypass -File C:\botplatform\scripts\dryrun-setup.ps1
```

It asks for your free Helius key, imports screener, screenerlp, screenerlp2 and swapcopy from `C:\bots`
**without wallet keys**, turns off the test screener's Slack posts, and starts everything in dry-run.

Check on it:

```
bp status                       # what is running
bp decisions slp --hours 6      # what the dry-run would have done
bp logs slp                     # raw log
```

## Going live (new VPS only)

```
bp secret slp PRIVATE_KEY -        # paste the key, Enter, then Ctrl+Z, Enter
bp live slp --confirm slp
```

Stop and fully close the old bot for that wallet **first**. Never run a wallet on two servers.

## Commands

`bp help` lists everything: `add`, `import`, `list/status`, `show`, `set`, `unset`, `secret`,
`enable/disable`, `dry/live`, `run`, `limit`, `positions`, `levers`, `decisions`, `logs`, `audit`.

## Development

`npm test` runs the suite (supervisor behaviour, keystore, limiter across threads, tracker, real legacy
bots loading inside worker threads). See `CLAUDE.md` for the rules this codebase follows.
