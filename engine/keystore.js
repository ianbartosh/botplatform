"use strict";
// Secrets (private keys, API keys, webhooks) are stored encrypted with AES-256-GCM.
// The encryption key is derived (scrypt) from a master passphrase that lives ONLY in the
// BP_MASTER_KEY environment variable of the service — never in the database or the repo.
// A check value in the DB lets the engine refuse to start with the wrong passphrase instead of
// handing a worker garbage keys.
const crypto = require("crypto");

const CHECK_PLAIN = "botplatform-keystore-v1";

class Keystore {
  constructor(store, passphrase) {
    if (!passphrase || passphrase.length < 12) throw new Error("BP_MASTER_KEY must be set (12+ characters)");
    this.store = store;
    let salt = store.getMeta("ks_salt");
    if (!salt) { salt = crypto.randomBytes(16).toString("base64"); store.setMeta("ks_salt", salt); }
    this.key = crypto.scryptSync(passphrase, Buffer.from(salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const check = store.getMeta("ks_check");
    if (!check) store.setMeta("ks_check", this.encrypt(CHECK_PLAIN));
    else {
      let ok = false;
      try { ok = this.decrypt(check) === CHECK_PLAIN; } catch {}
      if (!ok) throw new Error("BP_MASTER_KEY does not match the one this database was created with");
    }
  }
  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
  }
  decrypt(blob) {
    const [v, iv, tag, enc] = String(blob).split(".");
    if (v !== "v1") throw new Error("unknown secret format");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
  }
  setSecret(actor, instanceId, key, value) { this.store.putSecretBlob(actor, instanceId, key, this.encrypt(value)); }
  secrets(instanceId) {
    const out = {};
    for (const r of this.store.secretBlobs(instanceId)) out[r.key] = this.decrypt(r.blob);
    return out;
  }
}

// Which settings are secrets: anything that grants access or money if it leaks.
const SECRET_KEY_RE = /(PRIVATE_KEY|API_KEY|TOKEN|SECRET|WEBHOOK|PASSWORD|RPC_URL)/i;
const isSecretKey = k => SECRET_KEY_RE.test(k);

module.exports = { Keystore, isSecretKey };
