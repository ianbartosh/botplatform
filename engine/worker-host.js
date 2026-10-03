"use strict";
// Runs INSIDE a worker thread. Each instance gets its own thread with its own module scope and
// its own process.env, so legacy bots written as single-process scripts run side by side without
// sharing a single global. Stopping the thread stops the bot completely — there is no separate
// OS process that can survive as a ghost.
const { workerData, parentPort } = require("worker_threads");
const { SharedLimiter } = require("./limiter");

const { script, argv = [], limiterSab, limits, instanceId } = workerData;

new SharedLimiter(limits, limiterSab).install(globalThis);

// The legacy scripts print with console.*; worker stdout/stderr are captured by the supervisor.
// They also install process-level crash handlers that only log — keep that behaviour, but make sure
// a crash we cannot recover from still ends the thread so the supervisor restarts it.
process.argv = [process.argv[0], script, ...argv];
process.title = `bp:${instanceId}`;

parentPort.on("message", m => { if (m && m.type === "ping") parentPort.postMessage({ type: "pong", at: Date.now() }); });

// Load the bot as the MAIN module of this thread, exactly as `node script.js` would. Scripts that
// guard their entry point with `if (require.main === module)` (swapcopy does) would otherwise load
// and then silently do nothing.
const Module = require("module");
const path = require("path");
const m = new Module(script, null);
m.id = ".";
m.filename = script;
m.paths = Module._nodeModulePaths(path.dirname(script));
process.mainModule = m;
Module._cache[script] = m;
m.load(script);
