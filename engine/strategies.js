"use strict";
// The strategies the engine can run. Phase 1 runs the proven legacy bots unchanged inside worker
// threads; each strategy here says which script, what it needs, and how instance settings turn
// into that script's environment. Phase 1b replaces the legacy scripts one by one with the merged
// LP core without changing this interface.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const legacy = f => path.join(ROOT, "legacy", f);

// Settings that describe the stop-loss architecture of an LP instance (captured with each position
// so different SL setups can be compared later).
const SL_KEY_RE = /^(STOP_LOSS|IN_RANGE_HARD_SL|SL_CONFIRM|TSL_|HARD_SL|SCREENER_HARD_SL|SPIKE_|AUTO_CLOSE_OOR|FOLLOW_OOR|OOR_UP_ARM|HOLD_CLOSE)/;

const STRATEGIES = {
  copylp: {
    label: "Copy-LP (Meteora DLMM)",
    script: legacy("copylp.js"),
    version: "0.6.23",
    needsWallet: true,
    tracks: "lp",
    stateFile: "copylp_state.json",
    required: ["TARGET_WALLETS"],
    requiredSecrets: ["HELIUS_API_KEY"],
  },
  screenerlp: {
    label: "Screener-LP (Meteora DLMM)",
    script: legacy("screenerlp.js"),
    version: "0.7.18",
    needsWallet: true,
    tracks: "lp",
    stateFile: "copylp_state.json",
    required: ["PICKS_FROM"],            // id of the screener instance whose picks this trades
    requiredSecrets: ["HELIUS_API_KEY"],
  },
  screener: {
    label: "Meteora pool screener",
    script: legacy("screener.js"),
    version: "1.0",
    needsWallet: false,
    tracks: null,
    settingsFile: "screener_settings.json",  // the screener reads a JSON file, not env vars
    required: [],
    requiredSecrets: [],
  },
  swapcopy: {
    label: "Swap copy-trader (Jupiter, USDC)",
    script: legacy("swapcopy.js"),
    version: "1.2",
    needsWallet: true,
    tracks: "swap",
    stateFile: "swapcopy_state.json",
    required: ["SOURCE_WALLET"],
    requiredSecrets: ["RPC_URL"],
  },
};

function strategy(name) {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`unknown strategy '${name}' (have: ${Object.keys(STRATEGIES).join(", ")})`);
  return s;
}

// Problems that must be fixed before an instance can start.
function validate(inst, settings, secretKeys, allInstances = []) {
  const s = strategy(inst.strategy), errs = [];
  for (const k of s.required) if (!(settings[k] || "").trim()) errs.push(`setting ${k} is required`);
  for (const k of s.requiredSecrets) if (!secretKeys.includes(k)) errs.push(`secret ${k} is required`);
  if (s.needsWallet && !inst.dry_run && !secretKeys.includes("PRIVATE_KEY")) errs.push("secret PRIVATE_KEY is required to trade live");
  if (inst.strategy === "screenerlp" && settings.PICKS_FROM) {
    const src = allInstances.find(i => i.id === settings.PICKS_FROM);
    if (!src) errs.push(`PICKS_FROM '${settings.PICKS_FROM}' is not an instance`);
    else if (src.strategy !== "screener") errs.push(`PICKS_FROM '${settings.PICKS_FROM}' is not a screener`);
  }
  for (const k of Object.keys(settings)) if (/^(STATE_FILE|LOCK_OVERRIDE|DRY_RUN|BOT_DATA_DIR)$/.test(k)) errs.push(`${k} is managed by the engine; remove it`);
  return errs;
}

// Turn an instance into the environment its legacy script expects. Writes the screener's JSON
// settings file as a side effect (the screener reads only that file).
function buildEnv(inst, settings, secrets, { dataDir, instanceDir }) {
  const s = strategy(inst.strategy);
  const dir = instanceDir(inst.id);
  fs.mkdirSync(dir, { recursive: true });
  const env = {};
  // the OS basics every Node program expects (Windows needs SystemRoot etc. for DNS and crypto);
  // nothing else from the service's own environment leaks into a bot
  for (const k of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                   "ComSpec", "NUMBER_OF_PROCESSORS", "HOME", "LANG", "TZ"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    NODE_ENV: "production",
    DOTENV_CONFIG_PATH: path.join(dir, ".env.none"), DOTENV_CONFIG_QUIET: "true",   // legacy dotenv must load nothing
    BOT_NAME: inst.id,
    BOT_DATA_DIR: dir,
    DRY_RUN: inst.dry_run ? "true" : "false",
    LOCK_OVERRIDE: "1",            // the supervisor guarantees one worker per instance and per wallet
  });
  if (s.stateFile) env.STATE_FILE = path.join(dir, s.stateFile);

  if (s.settingsFile) {
    const json = {};
    for (const [k, v] of Object.entries({ ...settings, ...secrets })) {
      try { json[k] = JSON.parse(v); } catch { json[k] = v; }
    }
    const tmp = path.join(dir, s.settingsFile + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
    fs.renameSync(tmp, path.join(dir, s.settingsFile));
    return env;
  }

  for (const [k, v] of Object.entries(settings)) if (k !== "PICKS_FROM") env[k] = String(v);
  for (const [k, v] of Object.entries(secrets)) env[k] = String(v);
  if (inst.strategy === "screenerlp") env.SCREENER_PICKS = path.join(instanceDir(settings.PICKS_FROM), "screener_picks.json");
  if (!inst.dry_run) env.DRY_RUN = "false"; else delete env.PRIVATE_KEY;   // dry-run never holds a key
  return env;
}

function slConfig(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings)) if (SL_KEY_RE.test(k)) out[k] = v;
  return out;
}

module.exports = { STRATEGIES, strategy, validate, buildEnv, slConfig, ROOT };
