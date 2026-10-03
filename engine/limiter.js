"use strict";
// One rate limiter shared by every worker thread. Meteora's datapi allows ~30 req/s PER SERVER IP,
// so bots that each throttle themselves still overrun it together. The limiter lives in a
// SharedArrayBuffer: each bucket is a "next free slot" timestamp updated with compare-and-swap,
// so all threads draw from the same budget without messages or locks.
//
// Scope: it wraps globalThis.fetch in each worker (datapi, Jupiter, GeckoTerminal — what the
// legacy bots call with fetch). Solana RPC traffic from @solana/web3.js uses its own HTTP client
// and is not routed through here.

const DEFAULT_LIMITS = {
  "dlmm.datapi.meteora.ag": { rps: 20, burst: 10 },   // hard limit is 30/s per IP; keep headroom
  "lite-api.jup.ag":        { rps: 0, burst: 0 },     // 0 = unlimited (counted only)
  "api.jup.ag":             { rps: 0, burst: 0 },
};

const MAX_BUCKETS = 16;

class SharedLimiter {
  // limits: { host: { rps, burst } }. sab: pass an existing SharedArrayBuffer to attach (worker side).
  constructor(limits = DEFAULT_LIMITS, sab = null) {
    this.hosts = Object.keys(limits).slice(0, MAX_BUCKETS);
    this.limits = limits;
    this.sab = sab || new SharedArrayBuffer(8 * MAX_BUCKETS * 2);
    this.next = new BigInt64Array(this.sab, 0, MAX_BUCKETS);            // next free slot (ms)
    this.count = new BigInt64Array(this.sab, 8 * MAX_BUCKETS, MAX_BUCKETS); // requests seen
  }
  bucketFor(url) {
    let host;
    try { host = new URL(typeof url === "string" ? url : url.url || String(url)).host; } catch { return -1; }
    return this.hosts.indexOf(host);
  }
  // Reserve a slot; returns how many ms the caller must wait before sending.
  reserve(i, now = Date.now()) {
    const { rps, burst } = this.limits[this.hosts[i]];
    Atomics.add(this.count, i, 1n);
    if (!(rps > 0)) return 0;
    const interval = BigInt(Math.ceil(1000 / rps));
    const window = interval * BigInt(Math.max(0, burst | 0));
    const t = BigInt(now);
    for (;;) {
      const cur = Atomics.load(this.next, i);
      const slot = cur > t - window ? cur : t - window;
      if (Atomics.compareExchange(this.next, i, cur, slot + interval) === cur) {
        const wait = slot - t;
        return wait > 0n ? Number(wait) : 0;
      }
    }
  }
  stats() {
    const out = {};
    this.hosts.forEach((h, i) => { out[h] = { requests: Number(Atomics.load(this.count, i)), rps: this.limits[h].rps }; });
    return out;
  }
  // Install into the current thread: every fetch to a limited host waits for its slot.
  install(target = globalThis) {
    const raw = target.fetch;
    if (!raw || raw.__bpLimited) return;
    const self = this;
    const limited = async function (input, init) {
      const i = self.bucketFor(input);
      if (i >= 0) { const w = self.reserve(i); if (w > 0) await new Promise(r => setTimeout(r, w)); }
      return raw(input, init);
    };
    limited.__bpLimited = true;
    target.fetch = limited;
  }
}

module.exports = { SharedLimiter, DEFAULT_LIMITS };
