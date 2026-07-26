'use strict';
// lib/audio/consent.js — WP2R: self-owned audio consent store. Consent is a
// property of the LOCAL target node (the device that would sound), NOT of a
// peer record. Lives in a dedicated local file (~/.nexuscrew/audio.json),
// schema closed audio:{consent:boolean}, default OFF, atomic read/write.
// Never derived from a peer's nodes.json record. Local-only mutation; the
// federation whitelist never exposes it, so a federated consent mutation is
// unreachable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCHEMA_VERSION = 1;

// Il consenso vive accanto al token, nella stessa directory di stato del nodo:
// e' l'ancora gia' usata dal bridge di notifica (`notifyDir`) e resta corretta
// anche quando i test isolano l'istanza fuori dalla home reale. Ancorarlo a
// os.homedir() farebbe divergere server e Settings in quelle installazioni.
function consentPath(cfg = {}, home = (cfg.home || os.homedir())) {
  if (cfg.audioConsentPath) return cfg.audioConsentPath;
  if (cfg.tokenPath) return path.join(path.dirname(cfg.tokenPath), 'audio.json');
  return path.join(home, '.nexuscrew', 'audio.json');
}

function defaultConsent() {
  return { schemaVersion: SCHEMA_VERSION, audio: { consent: false } };
}

function readConsent(cfg = {}, home = (cfg.home || os.homedir())) {
  const p = consentPath(cfg, home);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultConsent();
    if (raw.schemaVersion !== SCHEMA_VERSION) return defaultConsent();
    if (!raw.audio || typeof raw.audio !== 'object' || Array.isArray(raw.audio)) return defaultConsent();
    if (Object.keys(raw.audio).some((k) => k !== 'consent')) return defaultConsent(); // schema chiuso
    if (typeof raw.audio.consent !== 'boolean') return defaultConsent();
    return { schemaVersion: SCHEMA_VERSION, audio: { consent: raw.audio.consent === true } };
  } catch (_) {
    return defaultConsent();
  }
}

function isConsent(cfg, home) {
  return readConsent(cfg, home).audio.consent === true;
}

function atomicWrite(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.audio.${process.pid}.${Math.floor(Date.now() * Math.random() + Date.now())}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function setConsent(cfg, consent, home = (cfg && cfg.home) || os.homedir()) {
  if (typeof consent !== 'boolean') throw new Error('consent deve essere boolean');
  const obj = { schemaVersion: SCHEMA_VERSION, audio: { consent } };
  atomicWrite(consentPath(cfg, home), obj);
  return { audio: { consent } };
}

module.exports = { consentPath, readConsent, isConsent, setConsent, defaultConsent, SCHEMA_VERSION };