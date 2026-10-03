"use strict";
// Stand-in for a legacy bot, driven by env vars, for supervisor tests.
const fs = require("fs");
const mode = process.env.FAKE_MODE || "run";
if (process.argv.includes("--close-all")) { console.log("CLI close-all done"); process.exit(0); }
console.log(`fakebot up mode=${mode} dry=${process.env.DRY_RUN} key=${process.env.PRIVATE_KEY ? "yes" : "no"} n=${process.env.FAKE_N || ""}`);
if (process.env.STATE_FILE) fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ mine: {}, n: process.env.FAKE_N || "" }));
if (mode === "crash") setTimeout(() => { throw new Error("boom"); }, 100);
else if (mode === "exit") setTimeout(() => process.exit(3), 100);
else if (mode === "hang") setTimeout(() => { for (;;) {} }, 100);
setInterval(() => console.log("[t] MIRROR abc123: fake open"), 150);
